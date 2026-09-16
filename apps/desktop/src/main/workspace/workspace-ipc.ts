// PR41: apps/desktop — Workspace IPC Module (thin handlers, no new service)
//
// Thin handlers over WorkspaceFileService / WorkspaceSearchService /
// DiagnosticsService. Mirrors the attachments:* handler pattern in
// main/ipc/index.ts: no PermissionManager call in IPC (agent tools enforce
// permissions); Zod schemas in @ai-desktop/shared validate before any
// handler runs.
//
// Security posture:
//   - Every path is project-scoped through resolveWorkspacePath inside the
//     services; the renderer never receives absolute main-side paths.
//   - WorkspaceError codes are preserved as "CODE: message" strings (same
//     convention as the coding tool executor's filesystem dispatch) so the
//     renderer can branch on failure kinds from the envelope message.
//   - There is intentionally NO workspace:execute channel — execution flows
//     through the agent tool router, never through IPC.

import type {
  TerminalCreateCommand,
  TerminalListCommand,
  TerminalOutputCommand,
  TerminalResizeCommand,
  TerminalStopCommand,
  TerminalWriteCommand,
  WorkspaceDiagnosticsClearCommand,
  WorkspaceDiagnosticsListCommand,
  WorkspaceDiagnosticsReportCommand,
  WorkspaceFilesCreateCommand,
  WorkspaceFilesDeleteCommand,
  WorkspaceFilesListCommand,
  WorkspaceFilesReadCommand,
  WorkspaceFilesRenameCommand,
  WorkspaceFilesWriteCommand,
  WorkspaceSearchCommand,
} from "@ai-desktop/shared";
import { DiagnosticsService } from "./workspace-diagnostics.js";
import { TerminalError, TerminalService } from "./terminal-service.js";
import { WorkspaceError } from "./workspace-errors.js";
import { WorkspaceFileService } from "./workspace-files.js";
import { WorkspaceSearchService, isSearchCancelledError } from "./workspace-search.js";

export interface WorkspaceIpcDependencies {
  readonly fileService: WorkspaceFileService;
  readonly searchService: WorkspaceSearchService;
  readonly diagnosticsService: DiagnosticsService;
  readonly terminalService: TerminalService;
}

function rethrowWorkspace(err: unknown): never {
  if (err instanceof WorkspaceError) {
    throw new Error(`${err.workspaceCode}: ${err.message}`);
  }
  if (err instanceof TerminalError) {
    throw new Error(`${err.terminalCode}: ${err.message}`);
  }
  if (isSearchCancelledError(err)) {
    throw new Error("CANCELLED: Workspace search was cancelled");
  }
  throw err instanceof Error ? err : new Error(String(err));
}

export async function listWorkspaceFiles(
  deps: WorkspaceIpcDependencies,
  input: WorkspaceFilesListCommand,
): Promise<{ result: unknown }> {
  try {
    const result = deps.fileService.listTree({
      projectId: input.projectId,
      ...(input.path !== undefined ? { path: input.path } : {}),
      ...(input.depth !== undefined ? { depth: input.depth } : {}),
    });
    return { result };
  } catch (err: unknown) {
    rethrowWorkspace(err);
  }
}

export async function readWorkspaceFile(
  deps: WorkspaceIpcDependencies,
  input: WorkspaceFilesReadCommand,
): Promise<{ result: unknown }> {
  try {
    const result = deps.fileService.readFile({
      projectId: input.projectId,
      path: input.path,
      ...(input.startLine !== undefined ? { startLine: input.startLine } : {}),
      ...(input.endLine !== undefined ? { endLine: input.endLine } : {}),
      ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
    });
    return { result };
  } catch (err: unknown) {
    rethrowWorkspace(err);
  }
}

export async function writeWorkspaceFile(
  deps: WorkspaceIpcDependencies,
  input: WorkspaceFilesWriteCommand,
): Promise<{ result: unknown }> {
  try {
    const result = deps.fileService.writeFile({
      projectId: input.projectId,
      path: input.path,
      content: input.content,
      ...(input.expectedMtimeMs !== undefined ? { expectedMtimeMs: input.expectedMtimeMs } : {}),
    });
    return { result };
  } catch (err: unknown) {
    rethrowWorkspace(err);
  }
}

export async function createWorkspaceEntry(
  deps: WorkspaceIpcDependencies,
  input: WorkspaceFilesCreateCommand,
): Promise<{ result: unknown }> {
  try {
    const result = input.directory
      ? deps.fileService.createDirectory({ projectId: input.projectId, path: input.path })
      : deps.fileService.createFile({
          projectId: input.projectId,
          path: input.path,
          content: input.content ?? "",
        });
    return { result };
  } catch (err: unknown) {
    rethrowWorkspace(err);
  }
}

export async function renameWorkspaceEntry(
  deps: WorkspaceIpcDependencies,
  input: WorkspaceFilesRenameCommand,
): Promise<{ result: unknown }> {
  try {
    const result = deps.fileService.rename({
      projectId: input.projectId,
      from: input.from,
      to: input.to,
    });
    return { result };
  } catch (err: unknown) {
    rethrowWorkspace(err);
  }
}

export async function deleteWorkspaceEntry(
  deps: WorkspaceIpcDependencies,
  input: WorkspaceFilesDeleteCommand,
): Promise<{ result: unknown }> {
  try {
    const result = deps.fileService.delete({ projectId: input.projectId, path: input.path });
    return { result };
  } catch (err: unknown) {
    rethrowWorkspace(err);
  }
}

export async function searchWorkspaceContent(
  deps: WorkspaceIpcDependencies,
  input: WorkspaceSearchCommand,
): Promise<{ result: unknown }> {
  try {
    const result = deps.searchService.search({
      projectId: input.projectId,
      ...(input.path !== undefined ? { path: input.path } : {}),
      query: input.query,
      ...(input.caseSensitive !== undefined ? { caseSensitive: input.caseSensitive } : {}),
      ...(input.wholeWord !== undefined ? { wholeWord: input.wholeWord } : {}),
      ...(input.include !== undefined ? { include: input.include } : {}),
      ...(input.maxResults !== undefined ? { maxResults: input.maxResults } : {}),
    });
    return { result };
  } catch (err: unknown) {
    rethrowWorkspace(err);
  }
}

export async function reportWorkspaceDiagnostics(
  deps: WorkspaceIpcDependencies,
  input: WorkspaceDiagnosticsReportCommand,
): Promise<{ result: unknown }> {
  try {
    const result = deps.diagnosticsService.report({
      projectId: input.projectId,
      source: input.source,
      diagnostics: input.diagnostics,
    });
    return { result };
  } catch (err: unknown) {
    rethrowWorkspace(err);
  }
}

export async function listWorkspaceDiagnostics(
  deps: WorkspaceIpcDependencies,
  input: WorkspaceDiagnosticsListCommand,
): Promise<{ diagnostics: unknown[] }> {
  try {
    const diagnostics = deps.diagnosticsService.list({
      projectId: input.projectId,
      ...(input.path !== undefined ? { path: input.path } : {}),
    });
    return { diagnostics: [...diagnostics] };
  } catch (err: unknown) {
    rethrowWorkspace(err);
  }
}

export async function clearWorkspaceDiagnostics(
  deps: WorkspaceIpcDependencies,
  input: WorkspaceDiagnosticsClearCommand,
): Promise<{ result: unknown }> {
  try {
    const result = deps.diagnosticsService.clear({
      projectId: input.projectId,
      ...(input.source !== undefined ? { source: input.source } : {}),
    });
    return { result };
  } catch (err: unknown) {
    rethrowWorkspace(err);
  }
}

export async function listTerminals(
  deps: WorkspaceIpcDependencies,
  input: TerminalListCommand,
): Promise<{ result: unknown }> {
  try {
    return { result: deps.terminalService.list({ projectId: input.projectId }) };
  } catch (err: unknown) {
    rethrowWorkspace(err);
  }
}

export async function createTerminal(
  deps: WorkspaceIpcDependencies,
  input: TerminalCreateCommand,
): Promise<{ result: unknown }> {
  try {
    const created = await deps.terminalService.create({
      projectId: input.projectId,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    });
    if (input.command !== undefined) {
      const started = await deps.terminalService.start({
        sessionId: created.id,
        projectId: input.projectId,
        command: input.command,
        ...(input.args !== undefined ? { args: input.args } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      });
      return { result: started };
    }
    return { result: created };
  } catch (err: unknown) {
    rethrowWorkspace(err);
  }
}

export async function writeTerminal(
  deps: WorkspaceIpcDependencies,
  input: TerminalWriteCommand,
): Promise<{ result: unknown }> {
  try {
    await deps.terminalService.write({
      sessionId: input.sessionId as never,
      projectId: input.projectId,
      input: input.input,
    });
    return { result: { written: true } };
  } catch (err: unknown) {
    rethrowWorkspace(err);
  }
}

export async function resizeTerminal(
  deps: WorkspaceIpcDependencies,
  input: TerminalResizeCommand,
): Promise<{ result: unknown }> {
  try {
    const result = await deps.terminalService.resize({
      sessionId: input.sessionId as never,
      projectId: input.projectId,
      cols: input.cols,
      rows: input.rows,
    });
    return { result };
  } catch (err: unknown) {
    rethrowWorkspace(err);
  }
}

export async function stopTerminal(
  deps: WorkspaceIpcDependencies,
  input: TerminalStopCommand,
): Promise<{ result: unknown }> {
  try {
    const result = await deps.terminalService.stop({
      sessionId: input.sessionId as never,
      projectId: input.projectId,
    });
    return { result };
  } catch (err: unknown) {
    rethrowWorkspace(err);
  }
}

export async function readTerminalOutput(
  deps: WorkspaceIpcDependencies,
  input: TerminalOutputCommand,
): Promise<{ result: unknown }> {
  try {
    const result = deps.terminalService.output({
      sessionId: input.sessionId as never,
      projectId: input.projectId,
      ...(input.tailBytes !== undefined ? { tailBytes: input.tailBytes } : {}),
    });
    return { result };
  } catch (err: unknown) {
    rethrowWorkspace(err);
  }
}
