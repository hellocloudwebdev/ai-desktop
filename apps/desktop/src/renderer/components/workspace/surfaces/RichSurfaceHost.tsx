// PR33.7: renderer — Rich Surface Host (kind switch + chrome)
//
// Switches on surface kind: document/table/form render in their dedicated
// surface (each inside a WorkspaceErrorBoundary so one bad payload cannot
// take down the host); chart/application render a constrained placeholder.
// Shows the title, a provenance line, the surface actions, and a dispose
// button. Owns no backend access: intent leaves via props callbacks.

import React from "react";
import { WorkspaceErrorBoundary } from "../WorkspaceErrorBoundary.js";
import type { SurfaceView } from "./surface-props.js";
import { DocumentSurface } from "./DocumentSurface.js";
import { TableSurface } from "./TableSurface.js";
import { FormSurface } from "./FormSurface.js";

export interface RichSurfaceHostProps {
  readonly surface: SurfaceView | null;
  onAction(actionId: string, input: unknown): void;
  onDispose(instanceId: string): void;
}

/** Kinds the PR33 renderer implements; others get a placeholder. */
export function isRenderedSurfaceKind(kind: string): boolean {
  return kind === "document" || kind === "table" || kind === "form";
}

export function RichSurfaceHost({
  surface,
  onAction,
  onDispose,
}: RichSurfaceHostProps): React.ReactElement {
  if (!surface) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-xs text-slate-500">Surface unavailable.</p>
      </div>
    );
  }

  const provenance = surface.provenance;
  const provenanceLine = `Source: ${provenance.source} · Origin: ${provenance.originId}${
    provenance.projectId ? ` · Project: ${provenance.projectId}` : ""
  }`;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto px-5 py-4">
      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-white truncate">
            {surface.title && surface.title.length > 0 ? surface.title : surface.instanceId}
          </h2>
          <p className="text-[11px] text-slate-500 font-mono break-all">{provenanceLine}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400 font-mono">
            {surface.kind} · {surface.status}
          </span>
          <button
            type="button"
            onClick={() => onDispose(surface.instanceId)}
            className="rounded-lg bg-slate-800 hover:bg-rose-900/60 border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:text-rose-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-colors"
          >
            Dispose
          </button>
        </div>
      </div>

      <div className="mt-3 min-w-0 flex-1">
        {surface.kind === "document" && (
          <WorkspaceErrorBoundary surfaceName={`Surface ${surface.instanceId.slice(0, 8)}`}>
            <DocumentSurface data={surface.data} actions={surface.actions} onAction={onAction} />
          </WorkspaceErrorBoundary>
        )}
        {surface.kind === "table" && (
          <WorkspaceErrorBoundary surfaceName={`Surface ${surface.instanceId.slice(0, 8)}`}>
            <TableSurface data={surface.data} onAction={onAction} />
          </WorkspaceErrorBoundary>
        )}
        {surface.kind === "form" && (
          <WorkspaceErrorBoundary surfaceName={`Surface ${surface.instanceId.slice(0, 8)}`}>
            <FormSurface data={surface.data} onAction={onAction} />
          </WorkspaceErrorBoundary>
        )}
        {!isRenderedSurfaceKind(surface.kind) && (
          <p className="text-xs text-slate-500">
            Surface kind &ldquo;{surface.kind}&rdquo; is not rendered in PR33.
          </p>
        )}
      </div>
    </div>
  );
}
