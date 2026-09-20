// PR47: renderer — lightweight update banner (state display only; no stack
// traces; execution stays main-side behind SecureUpdateService).

import React from "react";

export type UpdateBannerState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "verifying"
  | "downloaded"
  | "ready"
  | "installing"
  | "updated"
  | "up-to-date"
  | "failed";

export interface UpdateBannerProps {
  readonly state: UpdateBannerState;
  readonly version?: string | null;
  readonly error?: string | null;
  readonly onCheck: () => void;
  readonly onDownload: () => void;
  readonly onInstall: () => void;
}

function messageFor(state: UpdateBannerState, version?: string | null): string {
  switch (state) {
    case "checking":
      return "Checking for updates…";
    case "available":
      return version ? `Update available: v${version}` : "Update available";
    case "downloading":
      return "Downloading update…";
    case "verifying":
      return "Verifying update…";
    case "downloaded":
    case "ready":
      return version ? `Update v${version} ready to install` : "Update ready to install";
    case "installing":
      return "Installing update…";
    case "updated":
      return "Update installed — restart to finish";
    case "up-to-date":
      return "Up to date";
    case "failed":
      return "Update failed";
    case "idle":
    default:
      return "Check for updates";
  }
}

export function UpdateBanner({
  state,
  version,
  error,
  onCheck,
  onDownload,
  onInstall,
}: UpdateBannerProps): React.ReactElement {
  const tone =
    state === "failed"
      ? "border-red-800 bg-red-950/60 text-red-200"
      : state === "available" || state === "ready" || state === "downloaded"
        ? "border-emerald-800 bg-emerald-950/60 text-emerald-200"
        : "border-slate-800 bg-slate-900/60 text-slate-300";
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center justify-between gap-3 border-b px-6 py-1.5 text-xs font-mono ${tone}`}
    >
      <span>
        {messageFor(state, version)}
        {state === "failed" && error ? ` — ${error}` : null}
      </span>
      <span className="flex items-center gap-2">
        {state !== "checking" && state !== "downloading" && state !== "verifying" && (
          <button
            type="button"
            onClick={onCheck}
            className="rounded bg-slate-800 px-2 py-0.5 text-slate-200 hover:bg-slate-700"
          >
            Check
          </button>
        )}
        {state === "available" && (
          <button
            type="button"
            onClick={onDownload}
            className="rounded bg-emerald-800 px-2 py-0.5 text-emerald-100 hover:bg-emerald-700"
          >
            Download
          </button>
        )}
        {(state === "ready" || state === "downloaded") && (
          <button
            type="button"
            onClick={onInstall}
            className="rounded bg-emerald-700 px-2 py-0.5 text-white hover:bg-emerald-600"
          >
            Restart &amp; install
          </button>
        )}
      </span>
    </div>
  );
}
