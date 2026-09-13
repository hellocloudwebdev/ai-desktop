// PR31.13: renderer — Workspace Error Boundary
//
// A surface failure (coding panel, task list) must not crash the workspace.
// Each major surface renders inside one of these.

import React from "react";

interface WorkspaceErrorBoundaryProps {
  readonly surfaceName: string;
  readonly children: React.ReactNode;
}

interface WorkspaceErrorBoundaryState {
  readonly error: string | null;
}

export class WorkspaceErrorBoundary extends React.Component<
  WorkspaceErrorBoundaryProps,
  WorkspaceErrorBoundaryState
> {
  constructor(props: WorkspaceErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(err: unknown): WorkspaceErrorBoundaryState {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  override componentDidCatch(err: unknown): void {
    console.warn(`[workspace:${this.props.surfaceName}] surface error:`, err);
  }

  override render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div
          role="alert"
          aria-label={`${this.props.surfaceName} surface failed`}
          className="rounded-xl bg-rose-950/60 border border-rose-800 p-4 text-xs text-rose-200"
        >
          <p className="font-semibold mb-1">{this.props.surfaceName} surface failed</p>
          <p className="text-rose-300/80 font-mono break-words">{this.state.error}</p>
          <p className="mt-1 text-slate-400">Other surfaces are unaffected.</p>
        </div>
      );
    }
    return this.props.children;
  }
}
