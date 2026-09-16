// PR38: renderer — MCP Servers Surface
//
// List + details view over App-owned MCP server state. Owns no domain
// behavior: connect/disconnect and capability inspection stay behind the
// preload mcp:* commands and arrive here as handler props.

import React from "react";
import type { McpServersSurfaceProps, McpServerView } from "./surface-props.js";

const STATE_STYLES: Record<McpServerView["state"], string> = {
  ready: "bg-emerald-800 text-emerald-100",
  connecting: "bg-amber-800 text-amber-100",
  degraded: "bg-amber-800 text-amber-100",
  configured: "bg-slate-700 text-slate-300",
  disconnected: "bg-slate-800 text-slate-500",
  failed: "bg-red-800 text-red-100",
  stopped: "bg-slate-800 text-slate-500",
};

export function McpServersSurface({
  servers,
  activeProjectId,
  selectedServerId,
  onSelectServer,
  onDisconnect,
}: McpServersSurfaceProps): React.ReactElement {
  const selected =
    (selectedServerId != null ? servers.find((s) => s.id === selectedServerId) : undefined) ?? null;

  return (
    <div className="flex h-full min-h-0">
      <div className="w-64 shrink-0 border-r border-slate-800 overflow-y-auto px-4 py-4">
        <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-2 px-1">
          MCP Servers ({servers.length})
        </p>
        {servers.length === 0 ? (
          <p className="text-xs text-slate-500 px-1">No MCP servers configured.</p>
        ) : (
          <ul className="space-y-1" role="list">
            {servers.map((server) => {
              const active = server.id === selected?.id;
              return (
                <li key={server.id}>
                  <button
                    type="button"
                    onClick={() => onSelectServer(active ? null : server.id)}
                    aria-pressed={active}
                    className={`w-full text-left rounded-lg px-2.5 py-1.5 text-xs transition-colors focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
                      active
                        ? "bg-indigo-700 text-white font-medium"
                        : "text-slate-300 hover:bg-slate-800"
                    }`}
                  >
                    <span className="block truncate">{server.name}</span>
                    <span
                      className={`mt-0.5 block font-mono text-[10px] ${
                        active ? "text-indigo-200" : "text-slate-500"
                      }`}
                    >
                      {server.transport} · {server.toolCount} tools
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto px-6 py-4 text-xs">
        {!selected ? (
          <p className="text-slate-500">Select a server to see details.</p>
        ) : (
          <div>
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-sm font-semibold text-white">{selected.name}</h2>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATE_STYLES[selected.state]}`}
              >
                {selected.state}
              </span>
            </div>
            <p className="font-mono text-[10px] text-slate-500 mb-2">
              {selected.id} · {selected.transport}
            </p>

            <div className="flex items-center space-x-2 mb-4">
              <button
                type="button"
                onClick={() => onDisconnect(selected.id)}
                className="rounded-lg bg-slate-700 hover:bg-slate-600 px-3 py-1.5 text-xs font-medium text-slate-100 transition-colors"
              >
                Disconnect
              </button>
            </div>

            <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
              Capabilities ({selected.capabilities.length})
            </p>
            {selected.capabilities.length === 0 ? (
              <p className="text-slate-500 mb-3">No capabilities discovered.</p>
            ) : (
              <ul className="space-y-1 mb-3">
                {selected.capabilities.map((capability) => (
                  <li
                    key={capability}
                    className="rounded bg-slate-800/60 px-2 py-1 font-mono text-[11px] text-slate-200 break-all"
                  >
                    {capability}
                  </li>
                ))}
              </ul>
            )}

            <dl className="space-y-1 text-[11px]">
              <div className="flex space-x-2">
                <dt className="text-slate-500 shrink-0">Tools</dt>
                <dd className="font-mono text-slate-300">{selected.toolCount}</dd>
              </div>
              <div className="flex space-x-2">
                <dt className="text-slate-500 shrink-0">Resources</dt>
                <dd className="font-mono text-slate-300">{selected.resourceCount}</dd>
              </div>
              <div className="flex space-x-2">
                <dt className="text-slate-500 shrink-0">Prompts</dt>
                <dd className="font-mono text-slate-300">{selected.promptCount}</dd>
              </div>
              <div className="flex space-x-2">
                <dt className="text-slate-500 shrink-0">Project</dt>
                <dd className="font-mono text-slate-300 break-all">{activeProjectId}</dd>
              </div>
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}
