// PR31.6: renderer — Workspace Main (surface switch)
//
// Renders the active surface. Switching surfaces never restarts or cancels
// work: surfaces are pure views over App-owned backend state.

import React from "react";
import type { WorkspaceStore } from "../../workspace/store.js";
import { ChatSurface } from "./surfaces/ChatSurface.js";
import { CodingSurface } from "./surfaces/CodingSurface.js";
import { ActivitySurface, FilesSurface, TasksSurface } from "./surfaces/TaskSurfaces.js";
import type {
  ActivityEventView,
  ChatSurfaceProps,
  CodingSurfaceProps,
  FileEntryView,
  TasksSurfaceProps,
} from "./surfaces/surface-props.js";

interface WorkspaceMainProps {
  readonly store: WorkspaceStore;
  readonly chat: ChatSurfaceProps;
  readonly coding: CodingSurfaceProps;
  readonly tasks: TasksSurfaceProps;
  readonly activity: ActivityEventView[];
  readonly files: FileEntryView[];
}

export function WorkspaceMain({
  store,
  chat,
  coding,
  tasks,
  activity,
  files,
}: WorkspaceMainProps): React.ReactElement {
  const surface = store.state.activeSurface;
  if (surface === "coding") {
    return <CodingSurface {...coding} />;
  }
  if (surface === "tasks") {
    return <TasksSurface {...tasks} />;
  }
  if (surface === "activity") {
    return <ActivitySurface events={activity} />;
  }
  if (surface === "files") {
    return <FilesSurface activeProjectId={store.state.activeProjectId} touchedFiles={files} />;
  }
  return <ChatSurface {...chat} />;
}
