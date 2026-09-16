// PR39: renderer — Attachments Surface Tests
//
// The Files surface renders project attachments (metadata list, upload
// affordance, delete, bounded image-only preview) through established
// props — no new surface kind, no Node/Electron imports; attachment
// commands travel via the typed window.api bridge. There is intentionally
// NO attachments:read-path / media:readPath channel.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ATTACHMENTS_PREVIEW_MAX_BYTES,
  ATTACHMENTS_UPLOAD_MAX_BASE64,
  IPC_CHANNELS,
} from "@ai-desktop/shared";

const TASK_SURFACES = path.resolve(__dirname, "../components/workspace/surfaces/TaskSurfaces.tsx");
const CHAT_SURFACE = path.resolve(__dirname, "../components/workspace/surfaces/ChatSurface.tsx");
const PROPS = path.resolve(__dirname, "../components/workspace/surfaces/surface-props.ts");
const PRELOAD = path.resolve(__dirname, "../../preload/index.ts");

function read(file: string): string {
  return fs.readFileSync(file, "utf-8");
}

describe("Attachments surface contract (PR39)", () => {
  it("extends FilesSurfaceProps with optional attachment views", () => {
    const props = read(PROPS);
    expect(props).toContain("AttachmentFileView");
    expect(props).toContain("SelectedAttachmentPreview");
    expect(props).toContain("attachments?");
    expect(props).toContain("onUploadAttachment?");
    expect(props).toContain("onDeleteAttachment?");
    expect(props).toContain("onPreviewAttachment?");
  });

  it("renders attachments section with upload/list/delete/preview affordances", () => {
    const component = read(TASK_SURFACES);
    expect(component).toContain("Attachments:");
    expect(component).toContain("Upload attachment");
    expect(component).toContain("onDeleteAttachment");
    expect(component).toContain("onPreviewAttachment");
    expect(component).toContain("Close preview");
  });

  it("uploads via FileReader base64 with no Node/Electron imports", () => {
    const component = read(TASK_SURFACES);
    expect(component).toContain("FileReader");
    expect(component).toContain('type="file"');
    expect(component.includes("dangerouslySetInnerHTML")).toBe(false);
    expect(component).not.toMatch(/from\s+["']electron["']/);
    expect(component).not.toMatch(/from\s+["']node:/);
  });

  it("ChatSurface renders bounded image thumbnails and media cards", () => {
    const component = read(CHAT_SURFACE);
    expect(component).toContain("<img");
    expect(component).toContain("preview too large");
    expect(component).toContain("attachment:");
  });

  it("exposes typed window.api attachment commands", () => {
    const preload = read(PRELOAD);
    expect(preload).toContain("listAttachments");
    expect(preload).toContain("getAttachment");
    expect(preload).toContain("uploadAttachment");
    expect(preload).toContain("deleteAttachment");
    expect(preload).toContain("previewAttachment");
  });

  it("exposes no read-path / media:readPath channel anywhere near attachments", () => {
    const channels = Object.values(IPC_CHANNELS as Record<string, string>);
    for (const channel of [
      "attachments:list",
      "attachments:get",
      "attachments:upload",
      "attachments:delete",
      "attachments:preview",
    ]) {
      expect(channels).toContain(channel);
    }
    expect(channels).not.toContain("attachments:read-path");
    expect(channels).not.toContain("attachments:execute");
    expect(channels).not.toContain("attachments:raw-fs");
    expect(channels).not.toContain("media:readPath");
    const preload = read(PRELOAD);
    expect(preload).not.toMatch(/readPath\s*\(/);
    expect(preload).not.toMatch(/read-path["']/);
    expect(preload).not.toMatch(/["']attachments:read-path["']/);
  });

  it("caps preview bounds in the shared contract", () => {
    expect(ATTACHMENTS_PREVIEW_MAX_BYTES).toBe(204_800);
    expect(ATTACHMENTS_UPLOAD_MAX_BASE64).toBe(36_000_000);
  });
});
