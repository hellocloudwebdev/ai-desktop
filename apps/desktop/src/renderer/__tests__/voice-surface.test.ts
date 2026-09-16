// PR40: renderer — Voice Surface Tests
//
// The Voice surface renders session state + transcripts as plain data
// through established props — no new architecture, no native audio or
// provider handles; commands travel via the typed window.api realtime:*
// bridge. Microphone capture uses browser MediaRecorder in App (released
// on stop); playback state arrives via polling typed invoke.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "@ai-desktop/shared";

const SURFACE = path.resolve(__dirname, "../components/workspace/surfaces/VoiceSurface.tsx");
const PROPS = path.resolve(__dirname, "../components/workspace/surfaces/surface-props.ts");
const PRELOAD = path.resolve(__dirname, "../../preload/index.ts");

function read(file: string): string {
  return fs.readFileSync(file, "utf-8");
}

describe("Voice surface contract (PR40)", () => {
  it("extends props with voice session views", () => {
    const props = read(PROPS);
    expect(props).toContain("VoiceSessionView");
    expect(props).toContain("VoiceTranscriptView");
    expect(props).toContain("VoiceSurfaceProps");
    expect(props).toContain("onInterrupt");
    expect(props).toContain("onStop");
  });

  it("renders mic indicator, state, transcripts, and controls", () => {
    const component = read(SURFACE);
    expect(component).toContain("Microphone");
    expect(component).toContain("Interrupt");
    expect(component).toContain("Stop");
    expect(component).toContain("Start voice session");
    expect(component).toContain("Partial transcript");
  });

  it("keeps the surface free of privileged imports", () => {
    const component = read(SURFACE);
    expect(component.includes("dangerouslySetInnerHTML")).toBe(false);
    expect(component).not.toMatch(/from\s+["']electron["']/);
    expect(component).not.toMatch(/from\s+["']node:/);
    expect(component).not.toMatch(/MediaRecorder/);
    expect(component).not.toMatch(/AudioContext/);
  });

  it("exposes typed window.api realtime commands", () => {
    const preload = read(PRELOAD);
    expect(preload).toContain("createRealtimeSession");
    expect(preload).toContain("sendRealtimeAudio");
    expect(preload).toContain("getRealtimeTranscript");
    expect(preload).not.toMatch(/["']realtime:execute["']/);
  });

  it("registers no execute channel", () => {
    const channels = Object.values(IPC_CHANNELS);
    expect(channels).not.toContain("realtime:execute");
    expect(channels).not.toContain("voice:execute");
    expect(channels).not.toContain("audio:execute");
    expect(channels).toContain("realtime:audio");
    expect(channels).toContain("realtime:transcript");
  });
});
