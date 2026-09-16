// PR38: renderer — MCP Servers Surface Tests
//
// The MCP Servers surface renders host-owned server state (status,
// capabilities, counts) through established props — no new architecture,
// no raw privileged imports; commands travel via the typed window.api
// mcp:* bridge. No mcp:execute channel exists anywhere.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SURFACE = path.resolve(__dirname, "../components/workspace/surfaces/McpServersSurface.tsx");
const PROPS = path.resolve(__dirname, "../components/workspace/surfaces/surface-props.ts");
const PRELOAD = path.resolve(__dirname, "../../preload/index.ts");
const SHARED = path.resolve(__dirname, "../../../../../packages/shared/src/ipc-contract.ts");

function read(file: string): string {
  return fs.readFileSync(file, "utf-8");
}

describe("MCP servers surface contract (PR38)", () => {
  it("extends props with MCP server views", () => {
    const props = read(PROPS);
    expect(props).toContain("McpServerView");
    expect(props).toContain("McpServersSurfaceProps");
    expect(props).toContain("onDisconnect");
  });

  it("renders server state, capabilities, and counts", () => {
    const component = read(SURFACE);
    expect(component).toContain("MCP Servers");
    expect(component).toContain("Capabilities");
    expect(component).toContain("Disconnect");
    expect(component).toContain("onDisconnect");
  });

  it("keeps the surface free of privileged imports", () => {
    const component = read(SURFACE);
    expect(component.includes("dangerouslySetInnerHTML")).toBe(false);
    expect(component).not.toMatch(/from\s+["']electron["']/);
    expect(component).not.toMatch(/from\s+["']node:/);
    expect(component).not.toMatch(/child_process/);
  });

  it("exposes typed window.api MCP commands", () => {
    const preload = read(PRELOAD);
    expect(preload).toContain("listMcpServers");
    expect(preload).toContain("readMcpResource");
    expect(preload).toContain("subscribeMcp");
    expect(preload).not.toContain("executeMcp");
  });

  it("defines no mcp:execute channel in the shared contract", () => {
    const contract = read(SHARED);
    expect(contract).toContain("mcp:listServers");
    expect(contract).not.toContain('"mcp:execute"');
    expect(contract).not.toContain("MCP_EXECUTE");
  });
});
