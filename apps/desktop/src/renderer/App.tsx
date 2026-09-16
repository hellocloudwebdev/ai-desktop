import React, { useState, useEffect, useRef, useCallback } from "react";
import type { ConversationId, MessageId, Timestamp } from "@ai-desktop/shared";
import type {
  AIEvent,
  Message,
  ContentPart,
  ModelDefinition,
  PermissionRequest,
} from "@ai-desktop/ai-core";
import { useWorkspaceStore } from "./workspace/store.js";
import { fetchExtensionList, getExtensionCommands } from "./workspace/extensions.js";
import {
  disposeSurfaceInstance,
  fetchSurfaceList,
  invokeSurfaceAction,
} from "./workspace/surfaces.js";
import { WorkspaceShell } from "./components/workspace/Workspace.js";
import type {
  ActivityEventView,
  AttachmentFileView,
  BrowserPageView,
  DocumentFileView,
  ExtensionView,
  FileEntryView,
  McpServerView,
  ResearchDocumentView,
  ResearchProviderStatusView,
  ResearchResultView,
  SelectedAttachmentPreview,
  SelectedDocumentView,
  SurfaceView,
  VoiceSessionView,
  VoiceTranscriptView,
  WorkspaceDiagnosticView,
  WorkspaceDiffView,
  WorkspaceFileNode,
  WorkspaceSearchView,
  WorkspaceTab,
  WorkspaceTerminalView,
} from "./components/workspace/surfaces/surface-props.js";

const DEFAULT_CONVERSATION_ID = "01JM0000000000000000000001";

export function App(): React.ReactElement {
  const workspace = useWorkspaceStore();
  const [conversationId] = useState<string>(DEFAULT_CONVERSATION_ID);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [healthStatus, setHealthStatus] = useState<string>("checking...");
  const [availableModels, setAvailableModels] = useState<ModelDefinition[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([]);
  const [skills, setSkills] = useState<
    Array<{ id: string; name: string; state: string; enabled: boolean; active?: boolean }>
  >([]);
  const [memories, setMemories] = useState<
    Array<{
      id: string;
      content: string;
      category: string;
      scopeLevel: string;
      projectId?: string | null;
    }>
  >([]);
  const [agentTasks, setAgentTasks] = useState<
    Array<{
      taskId: string;
      status: string;
      nodes: Array<{ id: string; goal: string; status: string }>;
    }>
  >([]);
  const [agentGoal, setAgentGoal] = useState<string>("");
  const [agentRunning, setAgentRunning] = useState<boolean>(false);
  const [codingTasks, setCodingTasks] = useState<
    Array<{
      taskId: string;
      status: string;
      nodes: Array<{ id: string; goal: string; status: string }>;
    }>
  >([]);
  const [codingPrompt, setCodingPrompt] = useState<string>("");
  const [codingProjectId, setCodingProjectId] = useState<string>("sample-project");
  const [codingRunning, setCodingRunning] = useState<boolean>(false);
  // PR41: coding workspace state (App-owned backend state over the
  // workspace:*/terminal:* bridge; CodingWorkspace is a pure view).
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileNode[]>([]);
  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspaceTab[]>([]);
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<string | null>(null);
  const [workspaceSearch, setWorkspaceSearch] = useState<WorkspaceSearchView | null>(null);
  const [workspaceDiagnostics, setWorkspaceDiagnostics] = useState<WorkspaceDiagnosticView[]>([]);
  const [workspaceTerminals, setWorkspaceTerminals] = useState<WorkspaceTerminalView[]>([]);
  const [workspaceTerminalOutput, setWorkspaceTerminalOutput] = useState<string | null>(null);
  const [workspaceDiff, setWorkspaceDiff] = useState<WorkspaceDiffView | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  // Activity feed: bounded view over subscribed conversation events (PR31.11).
  const [activityEvents, setActivityEvents] = useState<ActivityEventView[]>([]);
  // Touched files derive from tool results in canonical events (PR31.11).
  const [touchedFiles, setTouchedFiles] = useState<FileEntryView[]>([]);
  // PR32: extensions list + selection (App-owned backend state, surface is a
  // pure view; commands arrive via the preload bridge).
  const [extensions, setExtensions] = useState<ExtensionView[]>([]);
  const [selectedExtensionId, setSelectedExtensionId] = useState<string | null>(null);
  // PR33: rich surfaces list (App-owned backend state, surface is a pure
  // view; actions/dispose arrive via the preload bridge when present).
  const [surfaces, setSurfaces] = useState<SurfaceView[]>([]);
  // PR34.5: browser pages list + active page + latest screenshot artifact
  const [browserPages, setBrowserPages] = useState<BrowserPageView[]>([]);
  const [activeBrowserPageId, setActiveBrowserPageId] = useState<string | null>(null);
  const [browserScreenshot, setBrowserScreenshot] = useState<{
    artifactRef: string;
    bytes: number;
  } | null>(null);
  // PR35: web research results + opened document + provider health (App-owned
  // backend state, surface is a pure view over the preload bridge).
  const [researchResults, setResearchResults] = useState<ResearchResultView[]>([]);
  const [activeResearchUrl, setActiveResearchUrl] = useState<string | null>(null);
  const [researchDocument, setResearchDocument] = useState<ResearchDocumentView | null>(null);
  const [researchProviders, setResearchProviders] = useState<ResearchProviderStatusView[]>([]);
  const [researchSearching, setResearchSearching] = useState<boolean>(false);
  const [researchError, setResearchError] = useState<string | null>(null);
  // PR37: project documents (App-owned backend state over the documents:*
  // preload bridge; Files surface is a pure view).
  const [projectDocuments, setProjectDocuments] = useState<DocumentFileView[]>([]);
  const [selectedDocument, setSelectedDocument] = useState<SelectedDocumentView | null>(null);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  // PR39: project attachments (App-owned backend state over the
  // attachments:* preload bridge; Files surface is a pure view).
  const [projectAttachments, setProjectAttachments] = useState<AttachmentFileView[]>([]);
  const [selectedAttachmentPreview, setSelectedAttachmentPreview] =
    useState<SelectedAttachmentPreview | null>(null);
  const [attachmentsError, setAttachmentsError] = useState<string | null>(null);
  // PR38: MCP servers list + selection (App-owned backend state over the
  // mcp:* preload bridge; McpServers surface is a pure view).
  const [mcpServers, setMcpServers] = useState<McpServerView[]>([]);
  const [selectedMcpServerId, setSelectedMcpServerId] = useState<string | null>(null);
  // PR40: voice session state (App-owned backend state over the realtime:*
  // bridge; Voice surface is a pure view). Microphone capture uses the
  // browser MediaRecorder API (renderer-side, user-gated); chunks stream
  // to main as bounded base64. Playback uses WebAudio from main events.
  const [voiceSession, setVoiceSession] = useState<VoiceSessionView | null>(null);
  const [voicePartial, setVoicePartial] = useState<string | null>(null);
  const [voiceFinals, setVoiceFinals] = useState<VoiceTranscriptView[]>([]);
  const [voiceWorking, setVoiceWorking] = useState<boolean>(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const voiceCaptureRef = useRef<{ stream: MediaStream; recorder: MediaRecorder } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // PR34.5: load browser pages through the preload bridge
  const refreshBrowserPages = useCallback(async () => {
    if (typeof window === "undefined" || !window.api) return;
    try {
      const res = await window.api.commands.listBrowserPages({
        projectId: workspace.state.activeProjectId,
      });
      if (res.ok && Array.isArray(res.value.pages)) {
        const pages = (res.value.pages as BrowserPageView[]).filter(
          (p) => p && typeof p.id === "string",
        );
        setBrowserPages(pages);
      }
    } catch (err) {
      console.warn("Failed to list browser pages:", err);
    }
  }, [workspace.state.activeProjectId]);

  useEffect(() => {
    void refreshBrowserPages();
  }, [refreshBrowserPages]);

  const handleOpenBrowserPage = useCallback(
    async (url: string) => {
      if (typeof window === "undefined" || !window.api) return;
      try {
        const res = await window.api.commands.openBrowserPage({
          projectId: workspace.state.activeProjectId,
          url,
        });
        if (res.ok && res.value.page) {
          const page = res.value.page as BrowserPageView;
          setActiveBrowserPageId(page.id);
          await refreshBrowserPages();
        }
      } catch (err) {
        console.warn("Failed to open browser page:", err);
      }
    },
    [refreshBrowserPages, workspace.state.activeProjectId],
  );

  const handleCloseBrowserPage = useCallback(
    async (pageId: string) => {
      if (typeof window === "undefined" || !window.api) return;
      try {
        await window.api.commands.closeBrowserPage({
          pageId: pageId as unknown as import("@ai-desktop/shared").BrowserPageId,
        });
        if (activeBrowserPageId === pageId) {
          setActiveBrowserPageId(null);
        }
        await refreshBrowserPages();
      } catch (err) {
        console.warn("Failed to close browser page:", err);
      }
    },
    [activeBrowserPageId, refreshBrowserPages],
  );

  const handleTakeScreenshot = useCallback(async (pageId: string) => {
    if (typeof window === "undefined" || !window.api) return;
    try {
      const res = await window.api.commands.captureBrowserScreenshot({
        pageId: pageId as unknown as import("@ai-desktop/shared").BrowserPageId,
      });
      if (res.ok && res.value.screenshot) {
        setBrowserScreenshot(res.value.screenshot as { artifactRef: string; bytes: number });
      }
    } catch (err) {
      console.warn("Failed to take screenshot:", err);
    }
  }, []);

  // PR35: web research handlers through the preload bridge.
  const handleResearchSearch = useCallback(
    async (query: string) => {
      if (typeof window === "undefined" || !window.api) return;
      setResearchSearching(true);
      setResearchError(null);
      try {
        const res = await window.api.commands.searchWeb({
          query,
          projectId: workspace.state.activeProjectId,
        });
        if (res.ok && Array.isArray(res.value.results)) {
          const views = (res.value.results as Array<Record<string, unknown>>)
            .filter((r) => r && typeof r["url"] === "string")
            .map((r) => {
              const source = (r["source"] as Record<string, unknown> | undefined) ?? {};
              return {
                title: String(r["title"] ?? (source["title"] as string | undefined) ?? r["url"]),
                url: String(r["url"]),
                snippet: String(r["excerpt"] ?? ""),
                domain: String(
                  ((r["metadata"] as Record<string, unknown> | undefined)?.["domain"] as
                    string | undefined) ?? "",
                ),
                provider: String((source["provider"] as string | undefined) ?? "unknown"),
              } satisfies ResearchResultView;
            });
          setResearchResults(views);
        } else if (!res.ok) {
          setResearchError(res.error.message);
        }
        try {
          const status = await window.api.commands.getResearchStatus();
          if (status.ok && Array.isArray(status.value.providers)) {
            setResearchProviders(
              (status.value.providers as Array<Record<string, unknown>>).map((p) => ({
                provider: String(p["provider"] ?? "unknown"),
                status: String(p["status"] ?? "unknown"),
              })),
            );
          }
        } catch {
          // Health snapshot is best-effort; search results stand alone.
        }
      } catch (err) {
        setResearchError(err instanceof Error ? err.message : String(err));
      } finally {
        setResearchSearching(false);
      }
    },
    [workspace.state.activeProjectId],
  );

  const handleResearchOpen = useCallback(
    async (url: string) => {
      if (typeof window === "undefined" || !window.api) return;
      setResearchError(null);
      setActiveResearchUrl(url);
      try {
        const res = await window.api.commands.openWebResearch({
          url,
          projectId: workspace.state.activeProjectId,
        });
        if (res.ok && res.value.result) {
          const r = res.value.result as Record<string, unknown>;
          const source = (r["source"] as Record<string, unknown> | undefined) ?? {};
          setResearchDocument({
            title: String(r["title"] ?? (source["title"] as string | undefined) ?? url),
            url: String(r["url"] ?? url),
            excerpt: String(r["excerpt"] ?? r["content"] ?? ""),
            provider: String((source["provider"] as string | undefined) ?? "unknown"),
            truncated: r["truncated"] === true,
          });
        } else if (!res.ok) {
          setResearchError(res.error.message);
        }
      } catch (err) {
        setResearchError(err instanceof Error ? err.message : String(err));
      }
    },
    [workspace.state.activeProjectId],
  );

  // PR37: project documents through the documents:* preload bridge.
  const refreshDocuments = useCallback(async () => {
    if (typeof window === "undefined" || !window.api) return;
    try {
      const res = await window.api.commands.listDocuments({
        projectId: workspace.state.activeProjectId,
      });
      if (res.ok && Array.isArray(res.value.documents)) {
        setProjectDocuments(
          (res.value.documents as Array<Record<string, unknown>>).map((d) => ({
            documentId: String(d["documentId"] ?? ""),
            name: String(d["name"] ?? ""),
            mimeType: String(d["mimeType"] ?? ""),
            sizeBytes: Number(d["sizeBytes"] ?? 0),
            status: String(d["status"] ?? ""),
            updatedAt: String(d["updatedAt"] ?? ""),
          })),
        );
      } else if (!res.ok) {
        setDocumentsError(res.error.message);
      }
    } catch (err) {
      setDocumentsError(err instanceof Error ? err.message : String(err));
    }
  }, [workspace.state.activeProjectId]);

  const handleSelectDocument = useCallback(
    async (documentId: string | null) => {
      if (typeof window === "undefined" || !window.api) return;
      if (documentId === null) {
        setSelectedDocument(null);
        return;
      }
      try {
        const res = await window.api.commands.getDocument({
          projectId: workspace.state.activeProjectId,
          documentId,
          maxChars: 4000,
        });
        if (res.ok && res.value.result) {
          const r = res.value.result as Record<string, unknown>;
          const doc = (r["document"] as Record<string, unknown> | undefined) ?? {};
          const metadata = (doc["metadata"] as Record<string, unknown> | undefined) ?? {};
          setSelectedDocument({
            documentId,
            name: String(doc["name"] ?? documentId),
            mimeType: String(doc["mimeType"] ?? ""),
            status: String(doc["status"] ?? ""),
            pageCount: typeof metadata["pageCount"] === "number" ? metadata["pageCount"] : null,
            preview: typeof r["text"] === "string" ? (r["text"] as string) : null,
            error: null,
          });
        } else if (!res.ok) {
          setDocumentsError(res.error.message);
        }
      } catch (err) {
        setDocumentsError(err instanceof Error ? err.message : String(err));
      }
    },
    [workspace.state.activeProjectId],
  );

  // PR32: load the extension list through the preload bridge. No-ops when
  // the bridge is absent (preload not yet updated, or non-Electron hosts).
  const refreshExtensions = useCallback(async () => {
    try {
      const commands = getExtensionCommands();
      if (!commands) return;
      setExtensions(await fetchExtensionList(commands));
    } catch (err) {
      console.warn("Failed to list extensions:", err);
    }
  }, []);

  useEffect(() => {
    void refreshExtensions();
  }, [refreshExtensions]);

  useEffect(() => {
    void refreshDocuments();
  }, [refreshDocuments]);

  useEffect(() => {
    void refreshDocuments();
  }, [refreshDocuments]);

  // PR41: coding workspace through the workspace:*/terminal:* bridge.
  // Tabs/dirty state are renderer-local; the filesystem stays authoritative
  // main-side (conflict detection via expectedMtimeMs on save).
  const refreshWorkspaceFiles = useCallback(async () => {
    if (typeof window === "undefined" || !window.api) return;
    try {
      const res = await window.api.commands.listWorkspaceFiles({
        projectId: workspace.state.activeProjectId,
      });
      if (res.ok) {
        const result = res.value.result as { entries?: WorkspaceFileNode[] };
        setWorkspaceFiles(Array.isArray(result.entries) ? result.entries : []);
      } else if (!res.ok) {
        setWorkspaceError(res.error.message);
      }
    } catch (err) {
      setWorkspaceError(err instanceof Error ? err.message : String(err));
    }
  }, [workspace.state.activeProjectId]);

  const refreshWorkspaceDiagnostics = useCallback(async () => {
    if (typeof window === "undefined" || !window.api) return;
    try {
      const res = await window.api.commands.listWorkspaceDiagnostics({
        projectId: workspace.state.activeProjectId,
      });
      if (res.ok && Array.isArray(res.value.diagnostics)) {
        setWorkspaceDiagnostics(
          (res.value.diagnostics as Array<Record<string, unknown>>).map((d) => ({
            path: String(d["path"] ?? ""),
            line: Number(d["line"] ?? 1),
            column: Number(d["column"] ?? 1),
            severity: String(d["severity"] ?? "information") as WorkspaceDiagnosticView["severity"],
            message: String(d["message"] ?? ""),
          })),
        );
      }
    } catch {
      // Diagnostics refresh is best-effort.
    }
  }, [workspace.state.activeProjectId]);

  const refreshWorkspaceTerminals = useCallback(async () => {
    if (typeof window === "undefined" || !window.api) return;
    try {
      const res = await window.api.commands.listTerminals({
        projectId: workspace.state.activeProjectId,
      });
      if (res.ok) {
        const result = res.value.result as Array<Record<string, unknown>>;
        setWorkspaceTerminals(
          (Array.isArray(result) ? result : []).map((t) => ({
            id: String(t["id"] ?? ""),
            state: String(t["state"] ?? ""),
            command: String(t["command"] ?? ""),
          })),
        );
      }
    } catch {
      // Terminal refresh is best-effort.
    }
  }, [workspace.state.activeProjectId]);

  useEffect(() => {
    void refreshWorkspaceFiles();
    void refreshWorkspaceDiagnostics();
    void refreshWorkspaceTerminals();
  }, [refreshWorkspaceFiles, refreshWorkspaceDiagnostics, refreshWorkspaceTerminals]);

  const handleOpenWorkspaceFile = useCallback(
    async (path: string) => {
      if (typeof window === "undefined" || !window.api) return;
      setWorkspaceError(null);
      try {
        const res = await window.api.commands.readWorkspaceFile({
          projectId: workspace.state.activeProjectId,
          path,
        });
        if (res.ok) {
          const result = res.value.result as {
            content?: string;
            mtimeMs?: number;
            truncated?: boolean;
          };
          setWorkspaceTabs((prev) => {
            if (prev.some((t) => t.path === path)) {
              return prev;
            }
            const next = [
              ...prev,
              {
                path,
                content: String(result.content ?? ""),
                dirty: false,
                conflict: false,
                mtimeMs: typeof result.mtimeMs === "number" ? result.mtimeMs : undefined,
              },
            ];
            return next.slice(-10);
          });
          setActiveWorkspaceTab(path);
        } else if (!res.ok) {
          setWorkspaceError(res.error.message);
        }
      } catch (err) {
        setWorkspaceError(err instanceof Error ? err.message : String(err));
      }
    },
    [workspace.state.activeProjectId],
  );

  const handleEditWorkspaceTab = useCallback((path: string, content: string) => {
    setWorkspaceTabs((prev) =>
      prev.map((t) => (t.path === path ? { ...t, content, dirty: true } : t)),
    );
  }, []);

  const handleSaveWorkspaceFile = useCallback(
    async (path: string) => {
      if (typeof window === "undefined" || !window.api) return;
      const tab = workspaceTabs.find((t) => t.path === path);
      if (!tab) {
        return;
      }
      try {
        const res = await window.api.commands.writeWorkspaceFile({
          projectId: workspace.state.activeProjectId,
          path,
          content: tab.content,
          ...(typeof tab.mtimeMs === "number" ? { expectedMtimeMs: tab.mtimeMs } : {}),
        });
        if (res.ok) {
          const result = res.value.result as { mtimeMs?: number };
          setWorkspaceTabs((prev) =>
            prev.map((t) =>
              t.path === path
                ? {
                    ...t,
                    dirty: false,
                    conflict: false,
                    ...(typeof result.mtimeMs === "number" ? { mtimeMs: result.mtimeMs } : {}),
                  }
                : t,
            ),
          );
          setWorkspaceDiff(null);
        } else if (!res.ok) {
          if (res.error.message.includes("EXTERNAL_MODIFIED")) {
            setWorkspaceTabs((prev) =>
              prev.map((t) => (t.path === path ? { ...t, conflict: true } : t)),
            );
          }
          setWorkspaceError(res.error.message);
        }
      } catch (err) {
        setWorkspaceError(err instanceof Error ? err.message : String(err));
      }
    },
    [workspace.state.activeProjectId, workspaceTabs],
  );

  const handleSaveAllWorkspaceFiles = useCallback(async () => {
    for (const tab of workspaceTabs.filter((t) => t.dirty)) {
      await handleSaveWorkspaceFile(tab.path);
    }
  }, [workspaceTabs, handleSaveWorkspaceFile]);

  const handleRevertWorkspaceFile = useCallback(
    async (path: string) => {
      if (typeof window === "undefined" || !window.api) return;
      try {
        const res = await window.api.commands.readWorkspaceFile({
          projectId: workspace.state.activeProjectId,
          path,
        });
        if (res.ok) {
          const result = res.value.result as { content?: string; mtimeMs?: number };
          setWorkspaceTabs((prev) =>
            prev.map((t) =>
              t.path === path
                ? {
                    ...t,
                    content: String(result.content ?? ""),
                    dirty: false,
                    conflict: false,
                    ...(typeof result.mtimeMs === "number" ? { mtimeMs: result.mtimeMs } : {}),
                  }
                : t,
            ),
          );
        }
      } catch (err) {
        setWorkspaceError(err instanceof Error ? err.message : String(err));
      }
    },
    [workspace.state.activeProjectId],
  );

  const handleCloseWorkspaceTab = useCallback(
    (path: string) => {
      const tab = workspaceTabs.find((t) => t.path === path);
      if (tab?.dirty) {
        const save = window.confirm(`Save changes to ${path} before closing?`);
        if (save) {
          void handleSaveWorkspaceFile(path);
          return;
        }
      }
      setWorkspaceTabs((prev) => prev.filter((t) => t.path !== path));
      setActiveWorkspaceTab((prev) => (prev === path ? null : prev));
    },
    [workspaceTabs, handleSaveWorkspaceFile],
  );

  const handleWorkspaceSearch = useCallback(
    async (query: string) => {
      if (typeof window === "undefined" || !window.api) return;
      try {
        const res = await window.api.commands.searchWorkspace({
          projectId: workspace.state.activeProjectId,
          query,
        });
        if (res.ok) {
          const result = res.value.result as {
            matches?: Array<{ path?: string; line?: number; column?: number; text?: string }>;
            truncated?: boolean;
          };
          setWorkspaceSearch({
            matches: (result.matches ?? []).map((m) => ({
              path: String(m.path ?? ""),
              line: Number(m.line ?? 1),
              column: Number(m.column ?? 1),
              text: String(m.text ?? ""),
            })),
            truncated: result.truncated === true,
          });
        } else if (!res.ok) {
          setWorkspaceError(res.error.message);
        }
      } catch (err) {
        setWorkspaceError(err instanceof Error ? err.message : String(err));
      }
    },
    [workspace.state.activeProjectId],
  );

  const handleTerminalCreate = useCallback(
    async (command: string) => {
      if (typeof window === "undefined" || !window.api) return;
      const [cmd, ...args] = command.split(/\s+/).filter(Boolean);
      if (!cmd) {
        return;
      }
      try {
        const res = await window.api.commands.createTerminal({
          projectId: workspace.state.activeProjectId,
          command: cmd,
          args,
        });
        if (res.ok) {
          await refreshWorkspaceTerminals();
          const result = res.value.result as { id?: string };
          if (typeof result.id === "string") {
            const out = await window.api.commands.readTerminalOutput({
              projectId: workspace.state.activeProjectId,
              sessionId: result.id,
            });
            if (out.ok) {
              const output = out.value.result as { text?: string };
              setWorkspaceTerminalOutput(String(output.text ?? ""));
            }
          }
        } else if (!res.ok) {
          setWorkspaceError(res.error.message);
        }
      } catch (err) {
        setWorkspaceError(err instanceof Error ? err.message : String(err));
      }
    },
    [workspace.state.activeProjectId, refreshWorkspaceTerminals],
  );

  const handleTerminalStop = useCallback(
    async (id: string) => {
      if (typeof window === "undefined" || !window.api) return;
      try {
        await window.api.commands.stopTerminal({
          projectId: workspace.state.activeProjectId,
          sessionId: id,
        });
        await refreshWorkspaceTerminals();
      } catch (err) {
        setWorkspaceError(err instanceof Error ? err.message : String(err));
      }
    },
    [workspace.state.activeProjectId, refreshWorkspaceTerminals],
  );

  // PR39: project attachments through the attachments:* preload bridge.
  // No-ops when the bridge is absent (preload not yet updated, or
  // non-Electron hosts). Uploads travel as base64; previews arrive as
  // bounded image bytes or metadata cards — never raw paths.
  const refreshAttachments = useCallback(async () => {
    if (typeof window === "undefined" || !window.api) return;
    try {
      const res = await window.api.commands.listAttachments({
        projectId: workspace.state.activeProjectId,
      });
      if (res.ok && Array.isArray(res.value.attachments)) {
        setProjectAttachments(
          (res.value.attachments as Array<Record<string, unknown>>).map((a) => ({
            attachmentId: String(a["attachmentId"] ?? ""),
            filename: String(a["filename"] ?? ""),
            mimeType: String(a["mimeType"] ?? ""),
            sizeBytes: Number(a["sizeBytes"] ?? 0),
            status: String(a["status"] ?? ""),
          })),
        );
      } else if (!res.ok) {
        setAttachmentsError(res.error.message);
      }
    } catch (err) {
      setAttachmentsError(err instanceof Error ? err.message : String(err));
    }
  }, [workspace.state.activeProjectId]);

  const handleUploadAttachment = useCallback(
    async (file: { name: string; mimeType: string; dataBase64: string }) => {
      if (typeof window === "undefined" || !window.api) return;
      try {
        const res = await window.api.commands.uploadAttachment({
          projectId: workspace.state.activeProjectId,
          fileName: file.name,
          mimeType: file.mimeType,
          contentBase64: file.dataBase64,
        });
        if (res.ok) {
          await refreshAttachments();
        } else {
          setAttachmentsError(res.error.message);
        }
      } catch (err) {
        setAttachmentsError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshAttachments, workspace.state.activeProjectId],
  );

  const handleDeleteAttachment = useCallback(
    async (attachmentId: string) => {
      if (typeof window === "undefined" || !window.api) return;
      try {
        const res = await window.api.commands.deleteAttachment({
          projectId: workspace.state.activeProjectId,
          attachmentId,
        });
        if (res.ok) {
          if (selectedAttachmentPreview?.attachmentId === attachmentId) {
            setSelectedAttachmentPreview(null);
          }
          await refreshAttachments();
        } else {
          setAttachmentsError(res.error.message);
        }
      } catch (err) {
        setAttachmentsError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshAttachments, selectedAttachmentPreview, workspace.state.activeProjectId],
  );

  const handlePreviewAttachment = useCallback(
    async (attachmentId: string | null) => {
      if (typeof window === "undefined" || !window.api) return;
      if (attachmentId === null) {
        setSelectedAttachmentPreview(null);
        return;
      }
      try {
        const res = await window.api.commands.previewAttachment({
          projectId: workspace.state.activeProjectId,
          attachmentId,
        });
        if (res.ok && res.value.preview) {
          const p = res.value.preview as Record<string, unknown>;
          const meta = (p["metadata"] as Record<string, unknown> | undefined) ?? {};
          setSelectedAttachmentPreview({
            attachmentId,
            kind: p["kind"] === "image" ? "image" : "card",
            mimeType: String(p["mimeType"] ?? meta["mimeType"] ?? ""),
            dataBase64: typeof p["dataBase64"] === "string" ? (p["dataBase64"] as string) : null,
          });
        } else if (!res.ok) {
          setAttachmentsError(res.error.message);
        }
      } catch (err) {
        setAttachmentsError(err instanceof Error ? err.message : String(err));
      }
    },
    [workspace.state.activeProjectId],
  );

  useEffect(() => {
    void refreshAttachments();
  }, [refreshAttachments]);

  // PR38: load MCP servers through the preload bridge. No-ops when the
  // bridge is absent (preload not yet updated, or non-Electron hosts).
  const refreshMcpServers = useCallback(async () => {
    if (typeof window === "undefined" || !window.api) return;
    try {
      const res = await window.api.commands.listMcpServers({});
      if (res.ok && Array.isArray(res.value.servers)) {
        setMcpServers(
          (res.value.servers as Array<Record<string, unknown>>).map((s) => ({
            id: String(s["id"] ?? ""),
            name: String(s["name"] ?? s["id"] ?? ""),
            transport: String(s["transport"] ?? "unknown"),
            state: String(s["state"] ?? "disconnected") as McpServerView["state"],
            toolCount: Number(s["toolCount"] ?? 0),
            resourceCount: Number(s["resourceCount"] ?? 0),
            promptCount: Number(s["promptCount"] ?? 0),
            capabilities: Array.isArray(s["capabilities"])
              ? (s["capabilities"] as unknown[]).map(String)
              : [],
          })),
        );
      }
    } catch (err) {
      console.warn("Failed to list MCP servers:", err);
    }
  }, []);

  useEffect(() => {
    void refreshMcpServers();
  }, [refreshMcpServers]);

  const handleDisconnectMcpServer = useCallback(
    async (serverId: string) => {
      if (typeof window === "undefined" || !window.api) return;
      try {
        await window.api.commands.disconnectMcpServer({ serverId });
        await refreshMcpServers();
      } catch (err) {
        console.warn("Failed to disconnect MCP server:", err);
      }
    },
    [refreshMcpServers],
  );

  // PR40: voice session helpers (realtime:* bridge; microphone via the
  // browser MediaRecorder API, released immediately on stop/error).
  const stopVoiceCapture = useCallback(() => {
    const capture = voiceCaptureRef.current;
    voiceCaptureRef.current = null;
    try {
      capture?.recorder.stop();
    } catch {
      // Recorder stop is best-effort; stream release below is authoritative.
    }
    for (const track of capture?.stream.getTracks() ?? []) {
      track.stop();
    }
  }, []);

  const refreshVoiceSession = useCallback(async (sessionId: string) => {
    if (typeof window === "undefined" || !window.api) return;
    try {
      const res = await window.api.commands.getRealtimeSession({ sessionId });
      if (res.ok && res.value.session) {
        const s = res.value.session as Record<string, unknown>;
        setVoiceSession({
          sessionId: String(s["sessionId"] ?? sessionId),
          state: String(s["state"] ?? "idle") as VoiceSessionView["state"],
          modelId: String(s["modelId"] ?? ""),
          providerId: String(s["providerId"] ?? ""),
        });
      }
    } catch (err) {
      console.warn("Failed to refresh voice session:", err);
    }
  }, []);

  const handleStartVoice = useCallback(async () => {
    if (typeof window === "undefined" || !window.api) return;
    setVoiceWorking(true);
    setVoiceError(null);
    setVoicePartial(null);
    try {
      const created = await window.api.commands.createRealtimeSession({
        projectId: workspace.state.activeProjectId,
        modelId: selectedModelId || "gemini:gemini-2.5-flash",
      });
      if (!created.ok || !created.value.session) {
        setVoiceError(created.ok ? "Session creation failed" : created.error.message);
        return;
      }
      const sessionId = String(
        (created.value.session as Record<string, unknown>)["sessionId"] ?? "",
      );
      const started = await window.api.commands.startRealtimeSession({ sessionId });
      if (!started.ok || !started.value.session) {
        setVoiceError(started.ok ? "Session start failed" : started.error.message);
        return;
      }
      await refreshVoiceSession(sessionId);
      // Microphone capture (user-gated by the browser; released on stop).
      const commands = window.api.commands;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
        voiceCaptureRef.current = { stream, recorder };
        recorder.ondataavailable = (event: BlobEvent) => {
          if (event.data.size === 0) {
            return;
          }
          const reader = new FileReader();
          reader.onload = () => {
            const url = String(reader.result ?? "");
            const base64 = url.includes(",") ? (url.split(",").pop() ?? "") : "";
            if (base64.length > 0 && base64.length <= 87380) {
              void commands.sendRealtimeAudio({ sessionId, payloadBase64: base64 });
            }
          };
          reader.readAsDataURL(event.data);
        };
        recorder.start(1000);
      } catch (err) {
        setVoiceError(
          `Microphone unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : String(err));
    } finally {
      setVoiceWorking(false);
    }
  }, [workspace.state.activeProjectId, selectedModelId, refreshVoiceSession]);

  const handleInterruptVoice = useCallback(async () => {
    if (typeof window === "undefined" || !window.api || !voiceSession) return;
    try {
      const res = await window.api.commands.interruptRealtimeSession({
        sessionId: voiceSession.sessionId,
      });
      if (res.ok) {
        await refreshVoiceSession(voiceSession.sessionId);
      }
    } catch (err) {
      console.warn("Failed to interrupt voice session:", err);
    }
  }, [voiceSession, refreshVoiceSession]);

  const handleStopVoice = useCallback(async () => {
    if (typeof window === "undefined" || !window.api || !voiceSession) return;
    stopVoiceCapture();
    try {
      await window.api.commands.stopRealtimeSession({ sessionId: voiceSession.sessionId });
      await refreshVoiceSession(voiceSession.sessionId);
    } catch (err) {
      console.warn("Failed to stop voice session:", err);
    }
  }, [voiceSession, refreshVoiceSession, stopVoiceCapture]);

  // PR40: poll live session state + transcripts (bounded retained buffer
  // main-side; polling keeps the renderer on typed invoke only).
  useEffect(() => {
    if (!voiceSession) {
      return;
    }
    const sessionId = voiceSession.sessionId;
    const timer = setInterval(() => {
      void (async () => {
        if (typeof window === "undefined" || !window.api) return;
        try {
          const [stateRes, transcriptRes] = await Promise.all([
            window.api.commands.getRealtimeSession({ sessionId }),
            window.api.commands.getRealtimeTranscript({ sessionId }),
          ]);
          if (stateRes.ok && stateRes.value.session) {
            const s = stateRes.value.session as Record<string, unknown>;
            setVoiceSession({
              sessionId,
              state: String(s["state"] ?? "idle") as VoiceSessionView["state"],
              modelId: String(s["modelId"] ?? ""),
              providerId: String(s["providerId"] ?? ""),
            });
            if (["stopped", "failed", "cancelled"].includes(String(s["state"] ?? ""))) {
              stopVoiceCapture();
              clearInterval(timer);
            }
          }
          if (transcriptRes.ok && transcriptRes.value.transcript) {
            const t = transcriptRes.value.transcript as {
              partial?: { text?: string } | null;
              finals?: Array<{ turnId?: string; text?: string }>;
            };
            setVoicePartial(typeof t.partial?.text === "string" ? t.partial.text : null);
            setVoiceFinals(
              Array.isArray(t.finals)
                ? t.finals.map((f, i) => ({
                    turnId: String(f.turnId ?? `turn-${i}`),
                    text: String(f.text ?? ""),
                  }))
                : [],
            );
          }
        } catch {
          // Polling is best-effort; errors surface on explicit actions.
        }
      })();
    }, 1000);
    return () => clearInterval(timer);
  }, [voiceSession?.sessionId, stopVoiceCapture]);

  // PR32: extension mutation handlers (mutate via bridge, then refresh).
  const handleEnableExtension = useCallback(
    async (extensionId: string) => {
      const commands = getExtensionCommands();
      if (!commands) return;
      try {
        await commands.enableExtension({ extensionId });
        await refreshExtensions();
      } catch (err) {
        console.warn("Failed to enable extension:", err);
      }
    },
    [refreshExtensions],
  );

  const handleDisableExtension = useCallback(
    async (extensionId: string) => {
      const commands = getExtensionCommands();
      if (!commands) return;
      try {
        await commands.disableExtension({ extensionId });
        await refreshExtensions();
      } catch (err) {
        console.warn("Failed to disable extension:", err);
      }
    },
    [refreshExtensions],
  );

  const handleExtensionProjectToggle = useCallback(
    async (extensionId: string, enabled: boolean) => {
      const commands = getExtensionCommands();
      if (!commands) return;
      try {
        await commands.setExtensionProjectEnabled({
          extensionId,
          projectId: workspace.state.activeProjectId,
          enabled,
        });
        await refreshExtensions();
      } catch (err) {
        console.warn("Failed to toggle extension project:", err);
      }
    },
    [refreshExtensions, workspace.state.activeProjectId],
  );

  const handleSelectExtension = useCallback((extensionId: string | null) => {
    setSelectedExtensionId(extensionId);
  }, []);

  // PR33: load the rich-surface list through window.api.commands. Scoped to
  // the active project; absent bridge (non-Electron hosts) yields [].
  const refreshSurfaces = useCallback(async () => {
    try {
      setSurfaces(await fetchSurfaceList(workspace.state.activeProjectId));
    } catch (err) {
      console.warn("Failed to list surfaces:", err);
    }
  }, [workspace.state.activeProjectId]);

  useEffect(() => {
    void refreshSurfaces();
  }, [refreshSurfaces]);

  // PR33: surface action/dispose handlers (invoke via bridge, then refresh).
  const handleSurfaceAction = useCallback(
    async (actionId: string, input: unknown) => {
      const instanceId = surfaces.find(
        (s) => s.instanceId === workspace.state.selectedSurfaceId,
      )?.instanceId;
      if (!instanceId) return;
      try {
        await invokeSurfaceAction(instanceId, actionId, input, workspace.state.activeProjectId);
        await refreshSurfaces();
      } catch (err) {
        console.warn("Failed to invoke surface action:", err);
      }
    },
    [refreshSurfaces, surfaces, workspace.state.activeProjectId, workspace.state.selectedSurfaceId],
  );

  const handleSurfaceDispose = useCallback(
    async (instanceId: string) => {
      try {
        await disposeSurfaceInstance(instanceId);
        workspace.selectSurfaceInstance(null);
        await refreshSurfaces();
      } catch (err) {
        console.warn("Failed to dispose surface:", err);
      }
    },
    [refreshSurfaces, workspace],
  );

  // Auto-scroll to latest message
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Handle incoming stream events incrementally (§39.29, §39.33)
  // Also appends a bounded activity entry per event (PR31.11 activity view).
  const handleStreamEvent = useCallback((event: AIEvent) => {
    const eventType = (event as { type?: string }).type ?? "unknown";
    if (eventType !== "message.delta") {
      setActivityEvents((prev) => {
        const entry: ActivityEventView = {
          key: `${eventType}:${event.sequence}:${prev.length}`,
          time: new Date(event.timestamp as string).toLocaleTimeString(),
          label: describeActivityEvent(eventType, event as Record<string, unknown>),
          kind: activityKindFor(eventType),
        };
        const next = [...prev, entry];
        return next.length > 200 ? next.slice(next.length - 200) : next;
      });
    }
    // Touched files: tool results carry JSON with "path" for filesystem ops.
    if (eventType === "tool.call.completed") {
      const result = (event as { result?: unknown }).result;
      if (typeof result === "string") {
        const match = /"path"\s*:\s*"([^"]+)"/.exec(result);
        if (match) {
          const filePath = match[1];
          setTouchedFiles((prev) => {
            if (prev.some((f) => f.path === filePath)) return prev;
            const next = [...prev, { path: filePath }];
            return next.length > 100 ? next.slice(next.length - 100) : next;
          });
        }
      }
    }
    setMessages((prevMessages) => {
      const updated = [...prevMessages];
      const anyEvent = event as {
        type: string;
        messageId?: string;
        role?: "system" | "user" | "assistant" | "tool";
        content?: readonly ContentPart[];
        deltaText?: string;
        error?: string;
      };

      const msgId = anyEvent.messageId;
      if (!msgId) {
        return updated;
      }

      const existingIndex = updated.findIndex((m) => m.id === msgId);

      switch (anyEvent.type) {
        case "message.started": {
          setIsStreaming(true);
          setActiveMessageId(msgId);
          if (existingIndex >= 0) {
            updated[existingIndex] = {
              ...updated[existingIndex],
              status: "streaming",
              updatedAt: event.timestamp as Timestamp,
            };
          } else {
            updated.push({
              id: msgId as MessageId,
              conversationId: event.conversationId as ConversationId,
              role: anyEvent.role ?? "assistant",
              content: anyEvent.content ?? [],
              status: "streaming",
              createdAt: event.timestamp as Timestamp,
              updatedAt: event.timestamp as Timestamp,
            });
          }
          break;
        }

        case "message.created": {
          if (existingIndex >= 0) {
            updated[existingIndex] = {
              ...updated[existingIndex],
              role: anyEvent.role ?? updated[existingIndex].role,
              content: anyEvent.content ?? updated[existingIndex].content,
              status: "completed",
              updatedAt: event.timestamp as Timestamp,
            };
          } else {
            updated.push({
              id: msgId as MessageId,
              conversationId: event.conversationId as ConversationId,
              role: anyEvent.role ?? "user",
              content: anyEvent.content ?? [],
              status: "completed",
              createdAt: event.timestamp as Timestamp,
              updatedAt: event.timestamp as Timestamp,
            });
          }
          break;
        }

        case "message.delta": {
          if (existingIndex >= 0 && anyEvent.deltaText) {
            const currentMsg = updated[existingIndex];
            const contentParts = [...currentMsg.content];
            const lastPart = contentParts[contentParts.length - 1];

            if (lastPart && lastPart.type === "text") {
              contentParts[contentParts.length - 1] = {
                ...lastPart,
                text: lastPart.text + anyEvent.deltaText,
              };
            } else {
              contentParts.push({ type: "text", text: anyEvent.deltaText });
            }

            updated[existingIndex] = {
              ...currentMsg,
              content: contentParts,
              status: "streaming",
              updatedAt: event.timestamp as Timestamp,
            };
          }
          break;
        }

        case "message.completed": {
          setIsStreaming(false);
          setActiveMessageId(null);
          if (existingIndex >= 0) {
            updated[existingIndex] = {
              ...updated[existingIndex],
              status: "completed",
              updatedAt: event.timestamp as Timestamp,
            };
          }
          break;
        }

        case "message.cancelled": {
          setIsStreaming(false);
          setActiveMessageId(null);
          if (existingIndex >= 0) {
            // Partial transcript preserved upon cancellation (§39.23, §39.34)
            updated[existingIndex] = {
              ...updated[existingIndex],
              status: "cancelled",
              updatedAt: event.timestamp as Timestamp,
            };
          }
          break;
        }

        case "message.failed": {
          setIsStreaming(false);
          setActiveMessageId(null);
          if (existingIndex >= 0) {
            updated[existingIndex] = {
              ...updated[existingIndex],
              status: "failed",
              updatedAt: event.timestamp as Timestamp,
            };
          }
          setErrorMessage(anyEvent.error ?? "Generation failed");
          break;
        }
      }

      return updated;
    });
  }, []);

  // PR31 subscription-identity correction: the event subscription depends only
  // on the conversation/subscription lifecycle inputs it consumes. Model
  // selection must not tear down and recreate the subscription.
  // (Effect deps updated below: [conversationId, handleStreamEvent].)

  // Initial load and event subscription lifecycle (§39.37, §39.38)
  useEffect(() => {
    if (typeof window === "undefined" || !window.api) {
      return;
    }

    // Check IPC health
    window.api.commands.checkHealth().then((res) => {
      setHealthStatus(res.ok ? "healthy" : "offline");
    });

    // PR22: Load available models across providers
    window.api.commands.listProviderModels().then((res) => {
      if (res.ok && res.value.models) {
        setAvailableModels(res.value.models);
        if (res.value.models.length > 0 && !selectedModelId) {
          setSelectedModelId(res.value.models[0].id);
        }
      }
    });

    // PR22: Load persisted conversation model
    window.api.commands
      .getConversationModel({ conversationId: conversationId as ConversationId })
      .then((res) => {
        if (res.ok && res.value.modelSelection) {
          const selection = res.value.modelSelection as { modelId: string };
          setSelectedModelId(selection.modelId);
        }
      });

    // PR24: Load any pending permission requests
    window.api.commands.listPendingPermissionRequests().then((res) => {
      if (res.ok && res.value.requests) {
        setPendingPermissions(res.value.requests);
      }
    });

    // PR26: Load installed skills
    window.api.commands.listSkills().then((res) => {
      if (res.ok && res.value.skills) {
        setSkills(
          res.value.skills as Array<{ id: string; name: string; state: string; enabled: boolean }>,
        );
      }
    });

    // PR28: Load durable memories
    window.api.commands.listMemories().then((res) => {
      if (res.ok && res.value.facts) {
        setMemories(
          res.value.facts as Array<{
            id: string;
            content: string;
            category: string;
            scopeLevel: string;
            projectId?: string | null;
          }>,
        );
      }
    });

    // PR29: Load known agent tasks (in-process registry snapshot)
    window.api.commands.listAgentTasks().then(() => {
      void refreshAgentTasks();
    });

    // PR30: Load known coding tasks (in-process registry snapshot)
    window.api.commands.listCodingTasks().then(() => {
      void refreshCodingTasks();
    });

    // 1. Restart recovery: reload historical conversation state from SQLite WAL events
    window.api.commands
      .loadConversation({ conversationId: conversationId as ConversationId })
      .then((res) => {
        if (res.ok && res.value.conversation) {
          setMessages([...res.value.conversation.messages]);
        }
      })
      .catch((err) => {
        console.warn("Failed to load historical conversation:", err);
      });

    // 2. Subscribe to streaming events via typed IPC batcher
    let unsubscribeFn: (() => void) | null = null;
    window.api.events.subscribeToConversation(conversationId, handleStreamEvent).then((unsub) => {
      unsubscribeFn = unsub;
    });

    return () => {
      if (unsubscribeFn) {
        unsubscribeFn();
      }
    };
  }, [conversationId, handleStreamEvent]);

  // Model selection change handler (§42 / PR22.10)
  const handleModelChange = async (newModelId: string) => {
    setSelectedModelId(newModelId);
    if (!window.api) {
      return;
    }
    const model = availableModels.find((m) => m.id === newModelId);
    if (model) {
      try {
        await window.api.commands.setConversationModel({
          conversationId: conversationId as ConversationId,
          providerId: model.providerId,
          modelId: model.id,
        });
      } catch (err) {
        console.warn("Failed to set conversation model:", err);
      }
    }
  };

  // PR24: Permission resolution handler (Allow once, session, project, deny)
  const handleResolvePermission = async (
    requestId: string,
    decision: "granted" | "denied",
    mode: "allow_once" | "allow_session" | "allow_project" | "deny",
  ) => {
    if (!window.api) {
      return;
    }
    try {
      await window.api.commands.resolvePermission({
        requestId: requestId as unknown as import("@ai-desktop/ai-core").PermissionRequestId,
        decision,
        mode,
      });
      setPendingPermissions((prev) => prev.filter((p) => p.id !== requestId));
    } catch (err) {
      console.warn("Failed to resolve permission request:", err);
    }
  };

  // PR26: Skill toggle enable/disable handler
  const handleToggleSkill = async (skillId: string, currentlyEnabled: boolean) => {
    if (!window.api) return;
    try {
      if (currentlyEnabled) {
        await window.api.commands.disableSkill({ skillId });
      } else {
        await window.api.commands.enableSkill({ skillId });
      }
      const res = await window.api.commands.listSkills();
      if (res.ok && res.value.skills) {
        setSkills(
          res.value.skills as Array<{ id: string; name: string; state: string; enabled: boolean }>,
        );
      }
    } catch (err) {
      console.warn("Failed to toggle skill:", err);
    }
  };

  // PR29: Agent task handlers (TaskGraph + per-node ReAct orchestration mode)
  const refreshAgentTasks = useCallback(async () => {
    const api = window.api;
    if (!api) return;
    try {
      const res = await api.commands.listAgentTasks();
      if (res.ok && res.value.taskIds) {
        const snapshots = await Promise.all(
          res.value.taskIds.map(async (taskId: string) => {
            try {
              const got = await api.commands.getAgentTask({
                taskId: taskId as unknown as import("@ai-desktop/shared").TaskId,
              });
              if (got.ok) {
                const task = got.value.task as {
                  taskId: string;
                  status: string;
                  graph: { nodes: Array<{ id: string; goal: string; status: string }> } | null;
                };
                return { taskId: task.taskId, status: task.status, nodes: task.graph?.nodes ?? [] };
              }
            } catch {
              // Task may have settled between list and get; skip it
            }
            return null;
          }),
        );
        setAgentTasks(
          snapshots.filter(
            (
              t,
            ): t is {
              taskId: string;
              status: string;
              nodes: Array<{ id: string; goal: string; status: string }>;
            } => t !== null,
          ),
        );
      }
    } catch (err) {
      console.warn("Failed to list agent tasks:", err);
    }
  }, []);

  const handleStartAgentTask = async () => {
    if (!window.api) return;
    const goal = agentGoal.trim();
    if (!goal || agentRunning) return;
    setAgentRunning(true);
    try {
      const res = await window.api.commands.startAgentTask({
        conversationId: conversationId as ConversationId,
        goal,
      });
      if (!res.ok) {
        setErrorMessage(res.error.message);
      } else {
        setAgentGoal("");
        await refreshAgentTasks();
      }
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to start agent task");
    } finally {
      setAgentRunning(false);
    }
  };

  const handleCancelAgentTask = async (taskId: string) => {
    if (!window.api) return;
    try {
      await window.api.commands.cancelAgentTask({
        taskId: taskId as unknown as import("@ai-desktop/shared").TaskId,
      });
      await refreshAgentTasks();
    } catch (err) {
      console.warn("Failed to cancel agent task:", err);
    }
  };

  // PR30: Coding task handlers (workspace-bound, project-scoped)
  const refreshCodingTasks = useCallback(async () => {
    const api = window.api;
    if (!api) return;
    try {
      const res = await api.commands.listCodingTasks();
      if (res.ok && res.value.taskIds) {
        const snapshots = await Promise.all(
          res.value.taskIds.map(async (taskId: string) => {
            try {
              const got = await api.commands.getCodingTask({
                taskId: taskId as unknown as import("@ai-desktop/shared").TaskId,
              });
              if (got.ok) {
                const task = got.value.task as {
                  taskId: string;
                  status: string;
                  graph: { nodes: Array<{ id: string; goal: string; status: string }> } | null;
                };
                return { taskId: task.taskId, status: task.status, nodes: task.graph?.nodes ?? [] };
              }
            } catch {
              // Task may have settled between list and get; skip it
            }
            return null;
          }),
        );
        setCodingTasks(
          snapshots.filter(
            (
              t,
            ): t is {
              taskId: string;
              status: string;
              nodes: Array<{ id: string; goal: string; status: string }>;
            } => t !== null,
          ),
        );
      }
    } catch (err) {
      console.warn("Failed to list coding tasks:", err);
    }
  }, []);

  const handleStartCodingTask = async () => {
    if (!window.api) return;
    const prompt = codingPrompt.trim();
    if (!prompt || codingRunning) return;
    setCodingRunning(true);
    try {
      const res = await window.api.commands.startCodingTask({
        projectId: codingProjectId.trim() || "sample-project",
        prompt,
      });
      if (!res.ok) {
        setErrorMessage(res.error.message);
      } else {
        setCodingPrompt("");
        await refreshCodingTasks();
      }
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to start coding task");
    } finally {
      setCodingRunning(false);
    }
  };

  const handleCancelCodingTask = async (taskId: string) => {
    if (!window.api) return;
    try {
      await window.api.commands.cancelCodingTask({
        taskId: taskId as unknown as import("@ai-desktop/shared").TaskId,
      });
      await refreshCodingTasks();
    } catch (err) {
      console.warn("Failed to cancel coding task:", err);
    }
  };

  // PR28: Memory delete handler
  const handleDeleteMemory = async (factId: string) => {
    if (!window.api) return;
    try {
      await window.api.commands.deleteMemory({ id: factId });
      setMemories((prev) => prev.filter((m) => m.id !== factId));
    } catch (err) {
      console.warn("Failed to delete import_guard fact:", err);
    }
  };

  // Send message handler (§39.7, §39.35, §42)
  const handleSend = async (e?: React.FormEvent) => {
    if (e) {
      e.preventDefault();
    }
    const text = inputText.trim();
    if (!text || isStreaming || !window.api) {
      return;
    }

    setInputText("");
    setErrorMessage(null);

    try {
      const res = await window.api.commands.sendChatMessage({
        conversationId: conversationId as ConversationId,
        content: text,
        modelId: selectedModelId || undefined,
      });

      if (!res.ok) {
        setErrorMessage(res.error.message);
      }
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to send message");
    }
  };

  // Cancel active stream handler (§39.8, §39.26, §39.34)
  const handleCancel = async () => {
    if (!activeMessageId || !window.api) {
      return;
    }

    try {
      await window.api.commands.cancelChat({
        conversationId: conversationId as ConversationId,
        messageId: activeMessageId as MessageId,
      });
    } catch (err: unknown) {
      console.warn("Failed to cancel message:", err);
    }
  };

  function renderMessageText(parts: readonly ContentPart[]): string {
    return parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
  }

  // PR31: derived workspace views (presentation derivations, not backend state).
  const activeTaskEntry = (() => {
    const selected = workspace.state.activeTaskId;
    if (selected) {
      const agent = agentTasks.find((t) => t.taskId === selected);
      if (agent) return { ...agent, kind: "agent" as const };
      const coding = codingTasks.find((t) => t.taskId === selected);
      if (coding) return { ...coding, kind: "coding" as const };
    }
    return null;
  })();

  // PR33: selected rich-surface view derives from store selection.
  const selectedSurfaceView =
    workspace.state.selectedSurfaceId !== null
      ? (surfaces.find((s) => s.instanceId === workspace.state.selectedSurfaceId) ?? null)
      : null;

  return (
    <WorkspaceShell
      store={workspace}
      conversationId={conversationId}
      healthStatus={healthStatus}
      isStreaming={isStreaming}
      surfaceHost={{
        surfaceView: selectedSurfaceView,
        onSurfaceAction: (actionId, input) => void handleSurfaceAction(actionId, input),
        onSurfaceDispose: (instanceId) => void handleSurfaceDispose(instanceId),
      }}
      sidebar={{
        activeSurface: workspace.state.activeSurface,
        activeProjectId: workspace.state.activeProjectId,
        conversationId,
        agentActiveCount: agentTasks.filter((t) => t.status === "active" || t.status === "blocked")
          .length,
        codingActiveCount: codingTasks.filter(
          (t) => t.status === "active" || t.status === "blocked",
        ).length,
        leftVisible: workspace.state.leftPanel.visible,
        rightVisible: workspace.state.rightPanel.visible,
        onSelectSurface: workspace.selectSurface,
        onSelectProject: (projectId) => {
          workspace.selectProject(projectId);
          setCodingProjectId(projectId);
        },
        onToggleLeft: () => workspace.togglePanel("left"),
        onToggleRight: () => workspace.togglePanel("right"),
        availableModels,
        selectedModelId,
        isStreaming,
        onModelChange: (modelId) => void handleModelChange(modelId),
        skills,
        memories,
        onToggleSkill: (skillId, enabled) => void handleToggleSkill(skillId, enabled),
        onDeleteMemory: (factId) => void handleDeleteMemory(factId),
        extensionsSummary: {
          total: extensions.length,
          active: extensions.filter((e) => e.lifecycle === "enabled" || e.lifecycle === "active")
            .length,
        },
      }}
      chat={{
        messages,
        errorMessage,
        pendingPermissions,
        messagesEndRef,
        renderMessageText,
        onResolvePermission: (requestId, decision, mode) =>
          void handleResolvePermission(requestId, decision, mode),
      }}
      coding={{
        codingTasks,
        codingPrompt,
        codingProjectId,
        codingRunning,
        onPromptChange: setCodingPrompt,
        onProjectChange: (projectId) => {
          setCodingProjectId(projectId);
          workspace.selectProject(projectId);
        },
        onStart: () => void handleStartCodingTask(),
        onCancel: (taskId) => void handleCancelCodingTask(taskId),
      }}
      codingWorkspace={{
        activeProjectId: workspace.state.activeProjectId,
        files: workspaceFiles,
        tabs: workspaceTabs,
        activeTabPath: activeWorkspaceTab,
        search: workspaceSearch,
        diagnostics: workspaceDiagnostics,
        terminals: workspaceTerminals,
        terminalOutput: workspaceTerminalOutput,
        diff: workspaceDiff,
        codingTasks,
        codingPrompt,
        codingRunning,
        workspaceError,
        onRefreshFiles: () => void refreshWorkspaceFiles(),
        onOpenFile: (path) => void handleOpenWorkspaceFile(path),
        onCloseTab: handleCloseWorkspaceTab,
        onSelectTab: setActiveWorkspaceTab,
        onEditTab: handleEditWorkspaceTab,
        onSaveFile: (path) => void handleSaveWorkspaceFile(path),
        onSaveAllFiles: () => void handleSaveAllWorkspaceFiles(),
        onRevertFile: (path) => void handleRevertWorkspaceFile(path),
        onSearch: (query) => void handleWorkspaceSearch(query),
        onTerminalCreate: (command) => void handleTerminalCreate(command),
        onTerminalStop: (id) => void handleTerminalStop(id),
        onPromptChange: setCodingPrompt,
        onProjectChange: (projectId) => {
          setCodingProjectId(projectId);
          workspace.selectProject(projectId);
        },
        onStartTask: () => void handleStartCodingTask(),
        onCancelTask: (taskId) => void handleCancelCodingTask(taskId),
      }}
      tasks={{
        agentTasks,
        codingTasks,
        activeTaskId: workspace.state.activeTaskId,
        agentGoal,
        agentRunning,
        onSelectTask: workspace.selectTask,
        onCancelAgent: (taskId) => void handleCancelAgentTask(taskId),
        onCancelCoding: (taskId) => void handleCancelCodingTask(taskId),
        onAgentGoalChange: setAgentGoal,
        onStartAgent: () => void handleStartAgentTask(),
      }}
      activity={activityEvents}
      files={touchedFiles}
      documents={projectDocuments}
      selectedDocument={selectedDocument}
      onSelectDocument={(documentId) => void handleSelectDocument(documentId)}
      documentsError={documentsError}
      attachments={projectAttachments}
      selectedAttachmentPreview={selectedAttachmentPreview}
      onPreviewAttachment={(attachmentId) => void handlePreviewAttachment(attachmentId)}
      attachmentsError={attachmentsError}
      onUploadAttachment={(file) => void handleUploadAttachment(file)}
      onDeleteAttachment={(attachmentId) => void handleDeleteAttachment(attachmentId)}
      extensions={{
        extensions,
        activeProjectId: workspace.state.activeProjectId,
        selectedExtensionId,
        onSelectExtension: handleSelectExtension,
        onEnable: (extensionId) => void handleEnableExtension(extensionId),
        onDisable: (extensionId) => void handleDisableExtension(extensionId),
        onProjectToggle: (extensionId, enabled) =>
          void handleExtensionProjectToggle(extensionId, enabled),
      }}
      browser={{
        activeProjectId: workspace.state.activeProjectId,
        pages: browserPages,
        activePageId: activeBrowserPageId,
        onSelectPage: setActiveBrowserPageId,
        onOpenPage: (url) => void handleOpenBrowserPage(url),
        onClosePage: (pageId) => void handleCloseBrowserPage(pageId),
        onTakeScreenshot: (pageId) => void handleTakeScreenshot(pageId),
        screenshotArtifact: browserScreenshot,
      }}
      mcp={{
        servers: mcpServers,
        activeProjectId: workspace.state.activeProjectId,
        selectedServerId: selectedMcpServerId,
        onSelectServer: setSelectedMcpServerId,
        onDisconnect: (serverId) => void handleDisconnectMcpServer(serverId),
      }}
      voice={{
        activeProjectId: workspace.state.activeProjectId,
        session: voiceSession,
        partialTranscript: voicePartial,
        finalTranscripts: voiceFinals,
        isWorking: voiceWorking,
        error: voiceError,
        onStart: () => void handleStartVoice(),
        onInterrupt: () => void handleInterruptVoice(),
        onStop: () => void handleStopVoice(),
      }}
      research={{
        activeProjectId: workspace.state.activeProjectId,
        results: researchResults,
        activeResultUrl: activeResearchUrl,
        openedDocument: researchDocument,
        providerStatuses: researchProviders,
        isSearching: researchSearching,
        searchError: researchError,
        onSearch: (query) => void handleResearchSearch(query),
        onOpenResult: (url) => void handleResearchOpen(url),
        onOpenInBrowser: (url) => void handleOpenBrowserPage(url),
      }}
      inspector={{
        activeTask: activeTaskEntry,
        activeConversationId: conversationId,
        activeProjectId: workspace.state.activeProjectId,
        files: touchedFiles,
        activity: activityEvents,
        onCancelTask: (kind, taskId) => {
          if (kind === "agent") void handleCancelAgentTask(taskId);
          else void handleCancelCodingTask(taskId);
        },
        surfaces,
        selectedSurfaceId: workspace.state.selectedSurfaceId,
        onSelectSurface: (id) => workspace.selectSurfaceInstance(id),
      }}
      composer={{
        activeSurface: workspace.state.activeSurface,
        inputText,
        codingPrompt,
        isStreaming,
        codingRunning,
        activeProjectId: workspace.state.activeProjectId,
        onInputChange: setInputText,
        onCodingPromptChange: setCodingPrompt,
        onSend: (e) => void handleSend(e),
        onCancel: () => void handleCancel(),
        onStartCoding: () => void handleStartCodingTask(),
      }}
    />
  );
}

// PR31.11: canonical-event → human-readable activity labels (view only).
function activityKindFor(eventType: string): string {
  if (eventType.startsWith("task.")) return "task";
  if (eventType.startsWith("tool.")) return "tool";
  if (eventType.startsWith("execution.")) return "execution";
  if (eventType.startsWith("permission.")) return "permission";
  if (eventType.startsWith("message.")) return "message";
  return "message";
}

function describeActivityEvent(eventType: string, event: Record<string, unknown>): string {
  const toolName = typeof event.toolName === "string" ? event.toolName : null;
  const nodeId = typeof event.taskNodeId === "string" ? event.taskNodeId.slice(0, 8) : null;
  switch (eventType) {
    case "task.created":
      return "Task started";
    case "task.completed":
      return "Task completed";
    case "task.failed":
      return `Task failed: ${typeof event.error === "string" ? event.error.slice(0, 120) : "error"}`;
    case "task.cancelled":
      return "Task cancelled";
    case "task.blocked":
      return "Task blocked: approval required";
    case "task.replan":
      return "Plan revised";
    case "task.node.started":
      return nodeId ? `Node started (${nodeId}…)` : "Node started";
    case "task.node.completed":
      return nodeId ? `Node completed (${nodeId}…)` : "Node completed";
    case "task.node.failed":
      return "Node failed";
    case "tool.call.started":
      return toolName ? `Tool started: ${toolName}` : "Tool started";
    case "tool.call.completed":
      return toolName ? `Tool completed: ${toolName}` : "Tool completed";
    case "tool.call.failed":
      return toolName ? `Tool failed: ${toolName}` : "Tool failed";
    case "message.started":
      return "Assistant responding";
    case "message.completed":
      return "Message completed";
    case "message.cancelled":
      return "Message cancelled";
    case "message.failed":
      return "Message failed";
    case "permission.requested":
      return "Permission requested";
    default:
      return eventType;
  }
}
