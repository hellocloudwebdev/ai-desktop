// PR31.2: renderer — Workspace Presentation Types
//
// Invariants:
//   1. Workspace / Project / Surface / Panel are presentation concepts only.
//      Backend systems (ChatService, AgentService, CodingAgentService, IPC,
//      projections) own behavior and data; the store only owns composition.
//   2. activeSurface is constrained to the surfaces PR31 actually renders.
//   3. Only serializable presentation state persists (localStorage, versioned).
//      Transient interaction state (hover, drag, streaming flags) never persists.

/** Surfaces the PR31 workspace actually renders. */
export const WORKSPACE_SURFACES = ["chat", "coding", "tasks", "activity", "files"] as const;
export type WorkspaceSurface = (typeof WORKSPACE_SURFACES)[number];

export function isWorkspaceSurface(value: unknown): value is WorkspaceSurface {
  return typeof value === "string" && (WORKSPACE_SURFACES as readonly string[]).includes(value);
}

export interface WorkspacePanelState {
  readonly visible: boolean;
  /** Width in pixels, clamped to panel min/max by the store. */
  readonly width: number;
}

export interface WorkspacePresentationState {
  readonly version: 1;
  readonly activeSurface: WorkspaceSurface;
  readonly activeProjectId: string;
  /** Presentation-side selection; conversation data stays backend-owned. */
  readonly activeConversationId: string | null;
  readonly activeTaskId: string | null;
  readonly leftPanel: WorkspacePanelState;
  readonly rightPanel: WorkspacePanelState;
}

export const WORKSPACE_STORAGE_KEY = "ai-desktop.workspace.v1";

export const WORKSPACE_PANEL_LIMITS = {
  left: { min: 180, max: 420, defaultWidth: 248 },
  right: { min: 220, max: 480, defaultWidth: 320 },
} as const;

export const DEFAULT_WORKSPACE_STATE: WorkspacePresentationState = {
  version: 1,
  activeSurface: "chat",
  activeProjectId: "sample-project",
  activeConversationId: null,
  activeTaskId: null,
  leftPanel: { visible: true, width: WORKSPACE_PANEL_LIMITS.left.defaultWidth },
  rightPanel: { visible: true, width: WORKSPACE_PANEL_LIMITS.right.defaultWidth },
};

export function clampPanelWidth(panel: "left" | "right", width: number): number {
  const limits = WORKSPACE_PANEL_LIMITS[panel];
  if (!Number.isFinite(width)) return limits.defaultWidth;
  return Math.min(limits.max, Math.max(limits.min, Math.round(width)));
}

/**
 * Validates unknown persisted data into workspace state. Returns safe
 * defaults on any malformed, stale-versioned, or partial payload.
 */
export function parseWorkspaceState(raw: unknown): WorkspacePresentationState {
  if (typeof raw !== "object" || raw === null) return DEFAULT_WORKSPACE_STATE;
  const data = raw as Record<string, unknown>;
  if (data.version !== 1) return DEFAULT_WORKSPACE_STATE;

  const activeSurface = isWorkspaceSurface(data.activeSurface)
    ? data.activeSurface
    : DEFAULT_WORKSPACE_STATE.activeSurface;
  const activeProjectId =
    typeof data.activeProjectId === "string" && data.activeProjectId.trim().length > 0
      ? data.activeProjectId
      : DEFAULT_WORKSPACE_STATE.activeProjectId;
  const activeConversationId =
    typeof data.activeConversationId === "string" && data.activeConversationId.length > 0
      ? data.activeConversationId
      : null;
  const activeTaskId =
    typeof data.activeTaskId === "string" && data.activeTaskId.length > 0
      ? data.activeTaskId
      : null;

  const parsePanel = (panel: "left" | "right", value: unknown): WorkspacePanelState => {
    const fallback =
      panel === "left" ? DEFAULT_WORKSPACE_STATE.leftPanel : DEFAULT_WORKSPACE_STATE.rightPanel;
    if (typeof value !== "object" || value === null) return fallback;
    const entry = value as Record<string, unknown>;
    return {
      visible: typeof entry.visible === "boolean" ? entry.visible : fallback.visible,
      width: typeof entry.width === "number" ? clampPanelWidth(panel, entry.width) : fallback.width,
    };
  };

  return {
    version: 1,
    activeSurface,
    activeProjectId,
    activeConversationId,
    activeTaskId,
    leftPanel: parsePanel("left", data.leftPanel),
    rightPanel: parsePanel("right", data.rightPanel),
  };
}
