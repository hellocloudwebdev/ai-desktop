// PR31: renderer — Workspace Integration Tests
//
// Proves the composition contract without a DOM: the shell receives
// backend-owned data through props, selection derives the inspector task,
// activity labels derive from canonical event types, and no new backend,
// IPC channel, or state machine is introduced for the workspace.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const RENDERER_SRC = path.join(__dirname, "..");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(RENDERER_SRC, relativePath), "utf8");
}

describe("renderer: workspace integration (PR31)", () => {
  it("App composes WorkspaceShell instead of the legacy single-column tree", () => {
    const app = readSource("App.tsx");
    expect(app).toContain("WorkspaceShell");
    expect(app).toContain("useWorkspaceStore");
    // Legacy popover booleans are gone; composition owns layout now.
    expect(app).not.toContain("showSkills");
    expect(app).not.toContain("showMemories");
    expect(app).not.toContain("showAgentTasks");
    expect(app).not.toContain("showCodingTasks");
  });

  it("App keeps every backend integration (no behavior dropped)", () => {
    const app = readSource("App.tsx");
    for (const command of [
      "sendChatMessage",
      "cancelChat",
      "startAgentTask",
      "cancelAgentTask",
      "startCodingTask",
      "cancelCodingTask",
      "resolvePermission",
      "listSkills",
      "listMemories",
      "listAgentTasks",
      "listCodingTasks",
      "loadConversation",
    ]) {
      expect(app, command).toContain(command);
    }
    expect(app).toContain("subscribeToConversation");
  });

  it("subscription lifecycle depends only on conversation identity", () => {
    const app = readSource("App.tsx");
    expect(app).toContain("[conversationId, handleStreamEvent]");
    expect(app).not.toContain("[conversationId, handleStreamEvent, selectedModelId]");
  });

  it("inspector selection derives from backend task lists (no duplicate state)", () => {
    const app = readSource("App.tsx");
    expect(app).toContain("workspace.state.activeTaskId");
    expect(app).toContain("agentTasks.find");
    expect(app).toContain("codingTasks.find");
  });

  it("surfaces import only types + React (no backend/service imports)", () => {
    const surfaceFiles = [
      "components/workspace/surfaces/ChatSurface.tsx",
      "components/workspace/surfaces/CodingSurface.tsx",
      "components/workspace/surfaces/TaskSurfaces.tsx",
      "components/workspace/WorkspaceSidebar.tsx",
      "components/workspace/WorkspaceInspector.tsx",
      "components/workspace/WorkspaceComposer.tsx",
      "components/workspace/WorkspaceMain.tsx",
      "components/workspace/Workspace.tsx",
    ];
    const forbidden = [
      "@ai-desktop/agent-runtime",
      "@ai-desktop/permissions",
      "@ai-desktop/execution",
      "@ai-desktop/storage",
      "@ai-desktop/memory",
      "@ai-desktop/providers",
      "@ai-desktop/mcp",
      "@ai-desktop/skills",
      'from "electron"',
      'from "node:',
    ];
    for (const file of surfaceFiles) {
      const content = readSource(file);
      for (const marker of forbidden) {
        expect(content, `${file} imports ${marker}`).not.toContain(marker);
      }
    }
  });

  it("no new IPC channels were added for the workspace", () => {
    const contract = fs.readFileSync(
      path.join(
        RENDERER_SRC,
        "..",
        "..",
        "..",
        "..",
        "packages",
        "shared",
        "src",
        "ipc-contract.ts",
      ),
      "utf8",
    );
    expect(contract).not.toContain("workspace:");
    expect(contract).not.toContain("WORKSPACE_");
  });

  it("no ai-core workspace domain was created (presentation stays local)", () => {
    const aiCore = path.join(RENDERER_SRC, "..", "..", "..", "..", "packages", "ai-core", "src");
    expect(fs.existsSync(path.join(aiCore, "workspace.ts"))).toBe(false);
  });
});
