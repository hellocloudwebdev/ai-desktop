// PR31.8: renderer — Accessible Panel Resize Handle
//
// Drag + keyboard resizing with min/max clamping (enforced by the store),
// double-click reset to default, and full ARIA labeling. Never drag-only:
// Arrow keys adjust by 8px, Shift+Arrow by 32px.

import React, { useCallback, useEffect, useRef } from "react";
import { WORKSPACE_PANEL_LIMITS } from "../../workspace/types.js";

interface WorkspaceResizeHandleProps {
  readonly panel: "left" | "right";
  readonly width: number;
  readonly onResize: (width: number) => void;
  readonly onReset: () => void;
}

const KEYBOARD_STEP = 8;
const KEYBOARD_LARGE_STEP = 32;

export function WorkspaceResizeHandle({
  panel,
  width,
  onResize,
  onReset,
}: WorkspaceResizeHandleProps): React.ReactElement {
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const limits = WORKSPACE_PANEL_LIMITS[panel];
  const label = panel === "left" ? "Resize navigation panel" : "Resize inspector panel";

  const clamp = useCallback(
    (value: number) => Math.min(limits.max, Math.max(limits.min, Math.round(value))),
    [limits],
  );

  const onPointerMove = useCallback(
    (clientX: number) => {
      const delta = panel === "left" ? clientX - startX.current : startX.current - clientX;
      onResize(clamp(startWidth.current + delta));
    },
    [clamp, onResize, panel],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleMove = (e: PointerEvent) => {
      if (dragging.current) onPointerMove(e.clientX);
    };
    const handleUp = () => {
      dragging.current = false;
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [onPointerMove]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onResize(clamp(width - step));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onResize(clamp(width + step));
    } else if (e.key === "Home") {
      e.preventDefault();
      onReset();
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        dragging.current = true;
        startX.current = e.clientX;
        startWidth.current = width;
      }}
      className="w-1.5 shrink-0 cursor-col-resize bg-transparent hover:bg-indigo-600/60 focus:bg-indigo-500 focus:outline-none transition-colors"
      title={`${label} (drag, arrow keys, double-click to reset)`}
    />
  );
}
