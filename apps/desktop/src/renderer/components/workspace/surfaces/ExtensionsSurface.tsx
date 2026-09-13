// PR32: renderer — Extensions Surface
//
// List + details view over App-owned extension state. Owns no domain
// behavior: install/enable/project scoping stay behind the preload commands
// and arrive here as handler props, mirroring the PR31 surface pattern.

import React from "react";
import type { ExtensionsSurfaceProps, ExtensionView } from "./surface-props.js";

const LIFECYCLE_STYLES: Record<ExtensionView["lifecycle"], string> = {
  active: "bg-emerald-800 text-emerald-100",
  enabled: "bg-indigo-800 text-indigo-100",
  installed: "bg-slate-700 text-slate-300",
  disabled: "bg-slate-800 text-slate-500",
};

function isEnabledForProject(extension: ExtensionView, projectId: string): boolean {
  return extension.enabledProjects.includes(projectId);
}

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

export function ExtensionsSurface({
  extensions,
  activeProjectId,
  selectedExtensionId,
  onSelectExtension,
  onEnable,
  onDisable,
  onProjectToggle,
}: ExtensionsSurfaceProps): React.ReactElement {
  const selected =
    (selectedExtensionId != null
      ? extensions.find((e) => e.id === selectedExtensionId)
      : undefined) ?? null;

  return (
    <div className="flex h-full min-h-0">
      <div className="w-64 shrink-0 border-r border-slate-800 overflow-y-auto px-4 py-4">
        <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-2 px-1">
          Extensions ({extensions.length})
        </p>
        {extensions.length === 0 ? (
          <p className="text-xs text-slate-500 px-1">No extensions installed.</p>
        ) : (
          <ul className="space-y-1" role="list">
            {extensions.map((extension) => {
              const active = extension.id === selected?.id;
              return (
                <li key={extension.id}>
                  <button
                    type="button"
                    onClick={() => onSelectExtension(active ? null : extension.id)}
                    aria-pressed={active}
                    className={`w-full text-left rounded-lg px-2.5 py-1.5 text-xs transition-colors focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
                      active
                        ? "bg-indigo-700 text-white font-medium"
                        : "text-slate-300 hover:bg-slate-800"
                    }`}
                  >
                    <span className="block truncate">
                      {extension.displayName ?? extension.name}
                    </span>
                    <span
                      className={`mt-0.5 block font-mono text-[10px] ${
                        active ? "text-indigo-200" : "text-slate-500"
                      }`}
                    >
                      v{extension.version}
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
          <p className="text-slate-500">Select an extension to see details.</p>
        ) : (
          <div>
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-sm font-semibold text-white">
                {selected.displayName ?? selected.name}
              </h2>
              <div className="flex items-center space-x-1.5">
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${LIFECYCLE_STYLES[selected.lifecycle]}`}
                >
                  {selected.lifecycle}
                </span>
                <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono text-slate-400">
                  trust: {selected.trust}
                </span>
              </div>
            </div>
            <p className="font-mono text-[10px] text-slate-500 mb-2">
              {selected.name} · v{selected.version}
            </p>
            {selected.description && (
              <p className="text-slate-300 leading-snug mb-3">{selected.description}</p>
            )}

            <div className="flex items-center space-x-2 mb-4">
              {selected.lifecycle === "disabled" || selected.lifecycle === "installed" ? (
                <button
                  type="button"
                  onClick={() => onEnable(selected.id)}
                  className="rounded-lg bg-emerald-700 hover:bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors"
                >
                  Enable
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onDisable(selected.id)}
                  className="rounded-lg bg-slate-700 hover:bg-slate-600 px-3 py-1.5 text-xs font-medium text-slate-100 transition-colors"
                >
                  Disable
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  onProjectToggle(selected.id, !isEnabledForProject(selected, activeProjectId))
                }
                aria-pressed={isEnabledForProject(selected, activeProjectId)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  isEnabledForProject(selected, activeProjectId)
                    ? "bg-indigo-700 hover:bg-indigo-600 text-white"
                    : "bg-slate-800 hover:bg-slate-700 text-slate-300"
                }`}
              >
                {isEnabledForProject(selected, activeProjectId)
                  ? `Enabled for ${activeProjectId}`
                  : `Enable for ${activeProjectId}`}
              </button>
            </div>

            <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
              Capabilities ({selected.capabilities.length})
            </p>
            {selected.capabilities.length === 0 ? (
              <p className="text-slate-500 mb-3">No capabilities declared.</p>
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
                <dt className="text-slate-500 shrink-0">Manifest</dt>
                <dd className="font-mono text-slate-300 break-all">
                  {selected.manifestHash ? shortHash(selected.manifestHash) : "—"}
                </dd>
              </div>
              <div className="flex space-x-2">
                <dt className="text-slate-500 shrink-0">Enabled projects</dt>
                <dd className="font-mono text-slate-300 break-all">
                  {selected.enabledProjects.length === 0
                    ? "—"
                    : selected.enabledProjects.join(", ")}
                </dd>
              </div>
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}
