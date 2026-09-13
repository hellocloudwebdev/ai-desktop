// PR31.2: renderer — Workspace Presentation Store
//
// useState/useReducer only, no new dependency. Loads versioned presentation
// state from localStorage (renderer-owned persistence boundary — no Prisma
// migration, no new IPC for layout preferences), persists on change, and
// falls back to safe defaults on malformed data.

import { useCallback, useEffect, useMemo, useReducer } from "react";
import {
  clampPanelWidth,
  DEFAULT_WORKSPACE_STATE,
  isWorkspaceSurface,
  parseWorkspaceState,
  WORKSPACE_STORAGE_KEY,
  type WorkspacePresentationState,
  type WorkspaceSurface,
} from "./types.js";

export type { WorkspacePresentationState, WorkspaceSurface, WorkspacePanelState } from "./types.js";
export { DEFAULT_WORKSPACE_STATE, WORKSPACE_STORAGE_KEY, isWorkspaceSurface };

export type WorkspaceAction =
  | { type: "surface/select"; surface: WorkspaceSurface }
  | { type: "project/select"; projectId: string }
  | { type: "conversation/select"; conversationId: string | null }
  | { type: "task/select"; taskId: string | null }
  | { type: "panel/toggle"; panel: "left" | "right" }
  | { type: "panel/setVisible"; panel: "left" | "right"; visible: boolean }
  | { type: "panel/setWidth"; panel: "left" | "right"; width: number }
  | { type: "state/replace"; state: WorkspacePresentationState };

function panelKey(panel: "left" | "right"): "leftPanel" | "rightPanel" {
  return panel === "left" ? "leftPanel" : "rightPanel";
}

/** Exported for tests: the transition contract the shell depends on. */
export function workspaceReducer(
  state: WorkspacePresentationState,
  action: WorkspaceAction,
): WorkspacePresentationState {
  switch (action.type) {
    case "surface/select":
      if (!isWorkspaceSurface(action.surface)) return state;
      return { ...state, activeSurface: action.surface };
    case "project/select": {
      const projectId = action.projectId.trim();
      if (projectId.length === 0) return state;
      // Switching projects clears task selection: PR28/PR30 project
      // isolation must be visible, never silently retained.
      return { ...state, activeProjectId: projectId, activeTaskId: null };
    }
    case "conversation/select":
      return { ...state, activeConversationId: action.conversationId };
    case "task/select":
      return { ...state, activeTaskId: action.taskId };
    case "panel/toggle": {
      const key = panelKey(action.panel);
      const panel = state[key];
      return { ...state, [key]: { ...panel, visible: !panel.visible } };
    }
    case "panel/setVisible": {
      const key = panelKey(action.panel);
      const panel = state[key];
      return { ...state, [key]: { ...panel, visible: action.visible } };
    }
    case "panel/setWidth": {
      const key = panelKey(action.panel);
      const panel = state[key];
      return {
        ...state,
        [key]: { ...panel, width: clampPanelWidth(action.panel, action.width) },
      };
    }
    case "state/replace":
      return parseWorkspaceState(action.state);
    default:
      return state;
  }
}

function loadInitialState(): WorkspacePresentationState {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return DEFAULT_WORKSPACE_STATE;
    }
    const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return DEFAULT_WORKSPACE_STATE;
    return parseWorkspaceState(JSON.parse(raw) as unknown);
  } catch {
    return DEFAULT_WORKSPACE_STATE;
  }
}

export interface WorkspaceStore {
  readonly state: WorkspacePresentationState;
  selectSurface(surface: WorkspaceSurface): void;
  selectProject(projectId: string): void;
  selectConversation(conversationId: string | null): void;
  selectTask(taskId: string | null): void;
  togglePanel(panel: "left" | "right"): void;
  setPanelVisible(panel: "left" | "right", visible: boolean): void;
  setPanelWidth(panel: "left" | "right", width: number): void;
}

export function useWorkspaceStore(): WorkspaceStore {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, loadInitialState);

  // Persist only the serializable presentation state on change.
  useEffect(() => {
    try {
      window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Quota or privacy mode: workspace still works for the session.
    }
  }, [state]);

  const selectSurface = useCallback(
    (surface: WorkspaceSurface) => dispatch({ type: "surface/select", surface }),
    [],
  );
  const selectProject = useCallback(
    (projectId: string) => dispatch({ type: "project/select", projectId }),
    [],
  );
  const selectConversation = useCallback(
    (conversationId: string | null) => dispatch({ type: "conversation/select", conversationId }),
    [],
  );
  const selectTask = useCallback(
    (taskId: string | null) => dispatch({ type: "task/select", taskId }),
    [],
  );
  const togglePanel = useCallback(
    (panel: "left" | "right") => dispatch({ type: "panel/toggle", panel }),
    [],
  );
  const setPanelVisible = useCallback(
    (panel: "left" | "right", visible: boolean) =>
      dispatch({ type: "panel/setVisible", panel, visible }),
    [],
  );
  const setPanelWidth = useCallback(
    (panel: "left" | "right", width: number) => dispatch({ type: "panel/setWidth", panel, width }),
    [],
  );

  return useMemo(
    () => ({
      state,
      selectSurface,
      selectProject,
      selectConversation,
      selectTask,
      togglePanel,
      setPanelVisible,
      setPanelWidth,
    }),
    [
      state,
      selectSurface,
      selectProject,
      selectConversation,
      selectTask,
      togglePanel,
      setPanelVisible,
      setPanelWidth,
    ],
  );
}
