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
      <div className="w-64 shrink-0 border-r border-slate-800/80 bg-slate-900/40 backdrop-blur-sm overflow-y-auto px-4 py-4">
        <p className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-2.5 px-1">
          MCP Servers ({servers.length})
        </p>
        {servers.length === 0 ? (
          <p className="text-xs text-slate-500 px-1 italic">No MCP servers configured.</p>
        ) : (
          <ul className="space-y-1.5" role="list">
            {servers.map((server) => {
              const active = server.id === selected?.id;
              return (
                <li key={server.id}>
                  <button
                    type="button"
                    onClick={() => onSelectServer(active ? null : server.id)}
                    aria-pressed={active}
                    className={`w-full text-left rounded-lg px-3 py-2 text-xs transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                      active
                        ? "bg-indigo-700 text-white font-medium shadow-sm shadow-indigo-600/30"
                        : "text-slate-300 hover:bg-slate-800/80 hover:text-white"
                    }`}
                  >
                    <span className="block truncate font-medium">{server.name}</span>
                    <span
                      className={`mt-0.5 block font-mono text-[10px] ${
                        active ? "text-indigo-100" : "text-slate-400"
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

      <div className="flex-1 min-w-0 overflow-y-auto px-6 py-5 text-xs">
        {!selected ? (
          <div className="flex h-full items-center justify-center text-slate-500 italic">
            <p>Select a server to see details.</p>
          </div>
        ) : (
          <div className="rounded-xl border border-slate-800/90 bg-slate-900/70 p-5 shadow-md shadow-black/20 space-y-4 max-w-3xl">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">{selected.name}</h2>
              <span
                className={`rounded-full px-2.5 py-0.5 text-[10px] font-medium border ${STATE_STYLES[selected.state]}`}
              >
                {selected.state}
              </span>
            </div>
            <p className="font-mono text-[11px] text-slate-400">
              {selected.id} · {selected.transport}
            </p>

            <div>
              <button
                type="button"
                onClick={() => onDisconnect(selected.id)}
                className="rounded-lg bg-slate-800 hover:bg-rose-950/80 hover:text-rose-300 border border-slate-700 hover:border-rose-800/50 px-3.5 py-1.5 text-xs font-medium text-slate-200 transition-colors shadow-sm"
              >
                Disconnect
              </button>
            </div>

            <div>
              <p className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-2">
                Capabilities ({selected.capabilities.length})
              </p>
              {selected.capabilities.length === 0 ? (
                <p className="text-slate-500 italic mb-3">No capabilities discovered.</p>
              ) : (
                <ul className="space-y-1.5 mb-4">
                  {selected.capabilities.map((capability) => (
                    <li
                      key={capability}
                      className="rounded-md bg-slate-950/70 border border-slate-800/80 px-2.5 py-1.5 font-mono text-[11px] text-slate-200 break-all"
                    >
                      {capability}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <dl className="grid grid-cols-4 gap-3 text-xs bg-slate-950/60 p-3.5 rounded-lg border border-slate-800/80">
              <div>
                <dt className="text-slate-400 font-medium">Tools</dt>
                <dd className="font-mono text-slate-200 text-sm mt-0.5">{selected.toolCount}</dd>
              </div>
              <div>
                <dt className="text-slate-400 font-medium">Resources</dt>
                <dd className="font-mono text-slate-200 text-sm mt-0.5">
                  {selected.resourceCount}
                </dd>
              </div>
              <div>
                <dt className="text-slate-400 font-medium">Prompts</dt>
                <dd className="font-mono text-slate-200 text-sm mt-0.5">{selected.promptCount}</dd>
              </div>
              <div>
                <dt className="text-slate-400 font-medium">Project</dt>
                <dd className="font-mono text-slate-200 text-sm mt-0.5 truncate">
                  {activeProjectId}
                </dd>
              </div>
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}
