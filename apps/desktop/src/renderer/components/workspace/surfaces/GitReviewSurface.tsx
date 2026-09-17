// PR42: renderer — Git Review Surface (staged review + commit)
//
// Self-contained view over App-owned git state. Owns no domain behavior:
// repository detection, status, diff, staging, history, and commits stay
// behind the `window.api.commands` git bridge (exposed by the preload;
// the git methods arrive with the sibling agent's IPC). Every bridge access
// is optional, so the surface compiles and renders a helpful message both
// before and after the git IPC lands. All failures surface as text; async
// work here never throws.
//
// PR42: register GitReviewSurface in workspace surfaces
//   Registered as the "git" workspace surface: "git" is listed in
//   WORKSPACE_SURFACES (workspace/types.ts), appears as the "Source Control"
//   tab (WorkspaceSidebar), and renders via the `surface === "git"` branch
//   (WorkspaceMain) with projectId from store.state.activeProjectId. No
//   App-owned props were added: the component self-fetches over the git
//   bridge. Once the sibling git IPC lands, no renderer change is needed —
//   the optional bridge calls below activate automatically.

import React, { useCallback, useEffect, useRef, useState } from "react";

type GitDiffLineKind = "context" | "add" | "del";

interface GitDiffLine {
  readonly kind: GitDiffLineKind;
  readonly text: string;
}

interface GitDiffHunk {
  readonly header: string | null;
  readonly lines: GitDiffLine[];
}

interface GitFileDiff {
  readonly path: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
  readonly hunks: GitDiffHunk[];
}

interface GitChangedFile {
  readonly path: string;
  readonly status: string;
  readonly staged: boolean;
  readonly additions: number;
  readonly deletions: number;
}

interface GitRepoState {
  readonly isRepo: boolean;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly empty: boolean;
  readonly ahead: number;
  readonly behind: number;
}

interface GitStatusState {
  readonly files: GitChangedFile[];
  readonly stagedCount: number;
  readonly clean: boolean;
  readonly branch: string | null;
  readonly ahead: number;
  readonly behind: number;
}

interface GitLogEntry {
  readonly hash: string;
  readonly subject: string;
  readonly author: string | null;
  readonly date: string | null;
}

interface GitBranchEntry {
  readonly name: string;
  readonly current: boolean;
}

// Minimal local view of the `window.api.commands` git bridge. Names and
// payloads match the preload exactly (see apps/desktop/src/preload/index.ts):
// every method takes `{ projectId, ... }` and resolves to an
// `IpcResponseEnvelope<{ result }>` whose `result` holds the GitService value.
interface GitReviewBridgeCommands {
  detectGitRepository?: (args: { projectId: string }) => Promise<unknown>;
  getGitStatus?: (args: { projectId: string }) => Promise<unknown>;
  getGitDiff?: (args: { projectId: string; staged?: boolean; path?: string }) => Promise<unknown>;
  getGitLog?: (args: { projectId: string; limit?: number }) => Promise<unknown>;
  getGitBranches?: (args: { projectId: string }) => Promise<unknown>;
  stageGitPaths?: (args: { projectId: string; paths: string[] }) => Promise<unknown>;
  unstageGitPaths?: (args: { projectId: string; paths: string[] }) => Promise<unknown>;
  commitGitStaged?: (args: { projectId: string; message: string }) => Promise<unknown>;
}

function getGitBridge(): GitReviewBridgeCommands | null {
  try {
    if (typeof window === "undefined") return null;
    const commands = window.api?.commands as unknown as GitReviewBridgeCommands | undefined;
    if (!commands || typeof commands.detectGitRepository !== "function") return null;
    return commands;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function unwrapGitValue(raw: unknown): unknown {
  // Preload resolves to IpcResponseEnvelope<{ result }> = { ok, value: { result } }.
  // Unwrap the envelope, then the handler's { result } wrapper.
  let current = raw;
  if (isRecord(current) && current.ok === true && "value" in current) current = current.value;
  if (isRecord(current) && "result" in current) return current.result;
  return current;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  if (isRecord(error)) {
    if (typeof error.message === "string" && error.message.length > 0) return error.message;
    if (typeof error.error === "string" && error.error.length > 0) return error.error;
  }
  return "Git request failed";
}

async function settle<T>(work: () => Promise<T>, fallback: T, problems: string[]): Promise<T> {
  try {
    return await work();
  } catch (error) {
    problems.push(toErrorMessage(error));
    return fallback;
  }
}

function normalizeRepo(raw: unknown): GitRepoState | null {
  // GitService.detectRepository -> { isRepo, rootPath?, currentBranch?, detached, headSha?, empty }.
  if (!isRecord(raw)) return null;
  if (!("isRepo" in raw) && !("currentBranch" in raw) && !("detached" in raw)) {
    return null;
  }
  const branch =
    typeof raw.currentBranch === "string"
      ? raw.currentBranch
      : typeof raw.branch === "string"
        ? raw.branch
        : null;
  return {
    isRepo: asBoolean(raw.isRepo, false),
    branch,
    detached: asBoolean(raw.detached, false),
    empty: asBoolean(raw.empty ?? raw.isEmpty, false),
    ahead: asNumber(raw.ahead, 0),
    behind: asNumber(raw.behind, 0),
  };
}

function statusLabelOf(item: Record<string, unknown>): string {
  if (asBoolean(item.conflicted, false)) return "conflicted";
  const wt = typeof item.workingTree === "string" ? item.workingTree : "";
  const ix = typeof item.index === "string" ? item.index : "";
  if (wt && wt !== "unmodified") return wt;
  if (ix && ix !== "unmodified") return ix;
  if (typeof item.status === "string" && item.status.length > 0) return item.status;
  return "modified";
}

function normalizeStatus(raw: unknown): GitStatusState | null {
  if (raw === null || raw === undefined) return null;
  const list =
    isRecord(raw) && Array.isArray(raw.files) ? raw.files : Array.isArray(raw) ? raw : null;
  if (list === null) return null;
  const files: GitChangedFile[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    if (typeof item.path !== "string" || item.path.length === 0) continue;
    files.push({
      path: item.path,
      status: statusLabelOf(item),
      staged: asBoolean(item.staged, false),
      additions: asNumber(item.additions, 0),
      deletions: asNumber(item.deletions, 0),
    });
  }
  const stagedCount =
    isRecord(raw) && typeof raw.stagedCount === "number" && Number.isFinite(raw.stagedCount)
      ? raw.stagedCount
      : files.filter((file) => file.staged).length;
  const clean = isRecord(raw) && typeof raw.clean === "boolean" ? raw.clean : files.length === 0;
  return {
    files,
    stagedCount,
    clean,
    branch: isRecord(raw) && typeof raw.branch === "string" ? raw.branch : null,
    ahead: isRecord(raw) ? asNumber(raw.ahead, 0) : 0,
    behind: isRecord(raw) ? asNumber(raw.behind, 0) : 0,
  };
}

function normalizeDiffKind(value: unknown): GitDiffLineKind {
  if (typeof value !== "string") return "context";
  const kind = value.toLowerCase();
  if (kind === "add" || kind === "added" || kind === "+") return "add";
  if (
    kind === "del" ||
    kind === "deleted" ||
    kind === "delete" ||
    kind === "removed" ||
    kind === "-"
  ) {
    return "del";
  }
  return "context";
}

function normalizeDiff(raw: unknown, fallbackPath: string): GitFileDiff | null {
  // GitService.getDiff -> GitDiff { files: GitFileDiff[], ... }.
  // The IPC layer requests a single path, so pick the matching (or first) file.
  let file: unknown = raw;
  if (isRecord(raw) && Array.isArray(raw.files)) {
    const files = raw.files.filter(isRecord);
    file =
      files.find((f) => f.path === fallbackPath) ??
      files.find((f) => typeof f.path === "string") ??
      null;
  }
  if (!isRecord(file)) return null;
  if (
    !("hunks" in file) &&
    !("isBinary" in file) &&
    !("binary" in file) &&
    !("status" in file) &&
    !("path" in file)
  )
    return null;
  const hunks: GitDiffHunk[] = [];
  if (Array.isArray(file.hunks)) {
    for (const entry of file.hunks) {
      if (!isRecord(entry)) continue;
      const lines: GitDiffLine[] = [];
      if (Array.isArray(entry.lines)) {
        for (const item of entry.lines) {
          if (!isRecord(item)) continue;
          lines.push({
            kind: normalizeDiffKind(item.kind),
            text: typeof item.text === "string" ? item.text : "",
          });
        }
      }
      hunks.push({ header: typeof entry.header === "string" ? entry.header : null, lines });
    }
  }
  return {
    path: typeof file.path === "string" && file.path.length > 0 ? file.path : fallbackPath,
    status: asString(file.status, "modified"),
    additions: asNumber(file.additions, 0),
    deletions: asNumber(file.deletions, 0),
    binary: asBoolean(file.isBinary ?? file.binary, false),
    hunks,
  };
}

function normalizeLog(raw: unknown): GitLogEntry[] {
  // GitService.getLog -> GitLog { commits: [{ sha, shortSha, author: { name, email, timestamp }, message, summary, parents }], total }.
  const list =
    isRecord(raw) && Array.isArray(raw.commits) ? raw.commits : Array.isArray(raw) ? raw : [];
  const entries: GitLogEntry[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const hash =
      typeof item.sha === "string" && item.sha.length > 0
        ? item.sha
        : typeof item.hash === "string" && item.hash.length > 0
          ? item.hash
          : typeof item.id === "string"
            ? item.id
            : "";
    if (hash.length === 0) continue;
    const author = isRecord(item.author)
      ? asString(item.author.name, "")
      : typeof item.author === "string"
        ? item.author
        : "";
    const date = isRecord(item.author)
      ? asString(item.author.timestamp, "")
      : typeof item.date === "string"
        ? item.date
        : "";
    entries.push({
      hash,
      subject:
        typeof item.summary === "string" && item.summary.length > 0
          ? item.summary
          : typeof item.subject === "string" && item.subject.length > 0
            ? item.subject
            : (asString(item.message, "(no message)").split("\n")[0] ?? "(no message)"),
      author: author.length > 0 ? author : null,
      date: date.length > 0 ? date : null,
    });
  }
  return entries;
}

function normalizeBranches(raw: unknown): GitBranchEntry[] {
  const list =
    isRecord(raw) && Array.isArray(raw.branches) ? raw.branches : Array.isArray(raw) ? raw : [];
  const branches: GitBranchEntry[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    if (typeof item.name !== "string" || item.name.length === 0) continue;
    branches.push({ name: item.name, current: asBoolean(item.current, false) });
  }
  return branches;
}

type FileGroup = "staged" | "changes" | "untracked" | "conflicts";

function groupOf(file: GitChangedFile): FileGroup {
  const status = file.status.toLowerCase();
  if (
    status.includes("conflict") ||
    status.includes("unmerged") ||
    status === "both-modified" ||
    status === "uu"
  ) {
    return "conflicts";
  }
  if (file.staged) return "staged";
  if (status.includes("untracked") || status === "?" || status === "??") return "untracked";
  return "changes";
}

function GitFileRow({
  file,
  selected,
  busy,
  onSelect,
  onToggleStaged,
}: {
  file: GitChangedFile;
  selected: boolean;
  busy: boolean;
  onSelect(path: string, staged: boolean): void;
  onToggleStaged(path: string, staged: boolean): void;
}): React.ReactElement {
  return (
    <li>
      <div
        className={`flex items-center gap-1 rounded px-1.5 py-1 ${
          selected ? "bg-indigo-700" : "hover:bg-slate-800"
        }`}
      >
        <button
          type="button"
          onClick={() => onSelect(file.path, file.staged)}
          aria-pressed={selected}
          className="min-w-0 flex-1 text-left focus:outline-none"
        >
          <span
            className={`block truncate font-mono text-[11px] ${
              selected ? "text-white" : "text-slate-200"
            }`}
          >
            {file.path}
          </span>
          <span
            className={`mt-0.5 block truncate text-[10px] ${
              selected ? "text-indigo-200" : "text-slate-500"
            }`}
          >
            {file.status} · +{file.additions} −{file.deletions}
          </span>
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onToggleStaged(file.path, file.staged)}
          aria-label={`${file.staged ? "Unstage" : "Stage"} ${file.path}`}
          className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-700 disabled:opacity-40"
        >
          {file.staged ? "Unstage" : "Stage"}
        </button>
      </div>
    </li>
  );
}

export function GitReviewSurface({
  projectId,
}: {
  readonly projectId: string;
}): React.ReactElement {
  const [repo, setRepo] = useState<GitRepoState | null>(null);
  const [status, setStatus] = useState<GitStatusState | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [stagedView, setStagedView] = useState<boolean>(false);
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState<boolean>(false);
  const [commits, setCommits] = useState<GitLogEntry[]>([]);
  const [branches, setBranches] = useState<GitBranchEntry[]>([]);
  const [commitMessage, setCommitMessage] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const requestRef = useRef(0);

  const loadRepository = useCallback(async (activeProjectId: string): Promise<void> => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    const isStale = (): boolean => requestRef.current !== requestId;
    setLoading(true);
    setError(null);
    // Pre-IPC guard: the sibling agent has not exposed the git bridge yet.
    const bridgeAvailable =
      typeof (window.api?.commands as unknown as GitReviewBridgeCommands | undefined)
        ?.detectGitRepository === "function";
    if (!bridgeAvailable) {
      setLoading(false);
      setError("Git IPC not available");
      return;
    }
    const commands = getGitBridge();
    if (!commands || typeof commands.detectGitRepository !== "function") {
      if (!isStale()) {
        setLoading(false);
        setError("Git IPC not available");
      }
      return;
    }
    const problems: string[] = [];
    try {
      const detect = commands.detectGitRepository;
      const repoState = await settle(
        async () => normalizeRepo(unwrapGitValue(await detect({ projectId: activeProjectId }))),
        null,
        problems,
      );
      if (isStale()) return;
      setRepo(repoState);
      if (!repoState || !repoState.isRepo) {
        setStatus(null);
        setCommits([]);
        setBranches([]);
      } else {
        const getStatus = commands.getGitStatus;
        const getLog = commands.getGitLog;
        const listBranches = commands.getGitBranches;
        const nextStatus =
          typeof getStatus === "function"
            ? await settle(
                async () =>
                  normalizeStatus(unwrapGitValue(await getStatus({ projectId: activeProjectId }))),
                null,
                problems,
              )
            : null;
        const nextCommits =
          typeof getLog === "function"
            ? await settle(
                async () =>
                  normalizeLog(
                    unwrapGitValue(await getLog({ projectId: activeProjectId, limit: 30 })),
                  ),
                [],
                problems,
              )
            : [];
        const nextBranches =
          typeof listBranches === "function"
            ? await settle(
                async () =>
                  normalizeBranches(
                    unwrapGitValue(await listBranches({ projectId: activeProjectId })),
                  ),
                [],
                problems,
              )
            : [];
        if (isStale()) return;
        // Merge branch/ahead/behind from status into the repo header state.
        setRepo(
          nextStatus && repoState
            ? {
                ...repoState,
                branch: nextStatus.branch ?? repoState.branch,
                ahead: nextStatus.ahead,
                behind: nextStatus.behind,
              }
            : repoState,
        );
        setStatus(nextStatus);
        setCommits(nextCommits);
        setBranches(nextBranches);
      }
      if (!isStale() && problems.length > 0) setError(problems.join("; "));
    } catch (loadError) {
      if (!isStale()) {
        setRepo(null);
        setError(toErrorMessage(loadError));
      }
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setSelectedPath(null);
    setDiff(null);
    setCommitMessage("");
    setActionError(null);
    void loadRepository(projectId);
  }, [projectId, loadRepository]);

  const refreshStatusAndLog = useCallback(
    async (activeProjectId: string): Promise<void> => {
      const commands = getGitBridge();
      if (!commands) return;
      const problems: string[] = [];
      const getStatus = commands.getGitStatus;
      const getLog = commands.getGitLog;
      if (typeof getStatus === "function") {
        const nextStatus = await settle(
          async () =>
            normalizeStatus(unwrapGitValue(await getStatus({ projectId: activeProjectId }))),
          status,
          problems,
        );
        setStatus(nextStatus);
      }
      if (typeof getLog === "function") {
        const nextCommits = await settle(
          async () =>
            normalizeLog(unwrapGitValue(await getLog({ projectId: activeProjectId, limit: 30 }))),
          commits,
          problems,
        );
        setCommits(nextCommits);
      }
      if (problems.length > 0) setActionError(problems.join("; "));
    },
    [commits, status],
  );

  const handleSelectFile = useCallback(
    async (path: string, staged: boolean): Promise<void> => {
      setSelectedPath(path);
      setStagedView(staged);
      setActionError(null);
      const commands = getGitBridge();
      const getDiff = commands?.getGitDiff;
      if (!commands || typeof getDiff !== "function") {
        setDiff(null);
        setActionError("Git diff is not available yet");
        return;
      }
      setDiffLoading(true);
      try {
        const raw = await getDiff(staged ? { projectId, path, staged: true } : { projectId, path });
        setDiff(normalizeDiff(unwrapGitValue(raw), path));
      } catch (diffError) {
        setDiff(null);
        setActionError(toErrorMessage(diffError));
      } finally {
        setDiffLoading(false);
      }
    },
    [projectId],
  );

  const handleToggleStaged = useCallback(
    async (path: string, staged: boolean): Promise<void> => {
      setActionError(null);
      const commands = getGitBridge();
      const stage = commands?.stageGitPaths;
      const unstage = commands?.unstageGitPaths;
      const apply = staged ? unstage : stage;
      if (!commands || typeof apply !== "function") {
        setActionError("Git IPC not available");
        return;
      }
      setBusy(true);
      try {
        await apply({ projectId, paths: [path] });
        await refreshStatusAndLog(projectId);
      } catch (stageError) {
        setActionError(toErrorMessage(stageError));
      } finally {
        setBusy(false);
      }
    },
    [projectId, refreshStatusAndLog],
  );

  const handleCommit = useCallback(async (): Promise<void> => {
    const message = commitMessage.trim();
    if (message.length === 0 || (status?.stagedCount ?? 0) === 0) return;
    setActionError(null);
    const commands = getGitBridge();
    const commit = commands?.commitGitStaged;
    if (!commands || typeof commit !== "function") {
      setActionError("Git IPC not available");
      return;
    }
    setBusy(true);
    try {
      await commit({ projectId, message });
      setCommitMessage("");
      setSelectedPath(null);
      setDiff(null);
      await refreshStatusAndLog(projectId);
    } catch (commitError) {
      setActionError(toErrorMessage(commitError));
    } finally {
      setBusy(false);
    }
  }, [commitMessage, projectId, refreshStatusAndLog, status]);

  const visibleFiles = (status?.files ?? []).slice(0, 500);
  const truncatedCount = (status?.files.length ?? 0) - visibleFiles.length;
  const stagedFiles = visibleFiles.filter((file) => groupOf(file) === "staged");
  const changedFiles = visibleFiles.filter((file) => groupOf(file) === "changes");
  const untrackedFiles = visibleFiles.filter((file) => groupOf(file) === "untracked");
  const conflictFiles = visibleFiles.filter((file) => groupOf(file) === "conflicts");
  const stagedCount = status?.stagedCount ?? 0;
  const canCommit = !busy && !loading && stagedCount > 0 && commitMessage.trim().length > 0;

  if (repo && !repo.isRepo) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="text-center">
          <p className="text-sm font-medium text-slate-200">Not a Git repository</p>
          <p className="mt-1 font-mono text-[11px] text-slate-500">{projectId}</p>
          <p className="mt-1 text-xs text-slate-500">
            Initialize a repository to review changes here.
          </p>
        </div>
      </div>
    );
  }

  if (error && !repo && !loading) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="text-center">
          <p className="text-sm font-medium text-slate-200">Source Control unavailable</p>
          <p className="mt-1 text-xs text-slate-500">{error}</p>
          <button
            type="button"
            onClick={() => void loadRepository(projectId)}
            className="mt-3 rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const branchLabel = !repo
    ? "…"
    : repo.empty
      ? "empty repo"
      : repo.detached
        ? "detached"
        : (repo.branch ?? "unknown");
  const syncLabel =
    !repo || (repo.ahead === 0 && repo.behind === 0)
      ? "in sync"
      : `ahead ${repo.ahead} · behind ${repo.behind}`;

  const renderGroup = (title: string, files: GitChangedFile[]): React.ReactElement | null => {
    if (files.length === 0) return null;
    return (
      <div className="mb-3">
        <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          {title} ({files.length})
        </p>
        <ul className="space-y-0.5" role="list">
          {files.map((file) => (
            <GitFileRow
              key={`${title}:${file.path}`}
              file={file}
              selected={file.path === selectedPath}
              busy={busy}
              onSelect={(path, staged) => void handleSelectFile(path, staged)}
              onToggleStaged={(path, staged) => void handleToggleStaged(path, staged)}
            />
          ))}
        </ul>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-800 px-4 py-2">
        <p className="font-mono text-[11px] text-slate-200">{branchLabel}</p>
        <span className="font-mono text-[10px] text-slate-500">{syncLabel}</span>
        {status ? (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
              status.clean ? "bg-emerald-800 text-emerald-100" : "bg-amber-800 text-amber-100"
            }`}
          >
            {status.clean ? "clean" : "dirty"}
          </span>
        ) : null}
        <span className="truncate font-mono text-[10px] text-slate-600">{projectId}</span>
        <span className="ml-auto flex items-center gap-2">
          {loading && <span className="text-[10px] text-slate-500">Loading…</span>}
          <button
            type="button"
            onClick={() => void loadRepository(projectId)}
            disabled={loading || busy}
            className="rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-700 disabled:opacity-40"
          >
            Refresh
          </button>
        </span>
      </div>
      {error && (
        <p className="shrink-0 border-b border-red-900/50 bg-red-950/40 px-4 py-1 text-[11px] text-red-300">
          {error}
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="w-60 shrink-0 overflow-y-auto border-r border-slate-800 px-3 py-3">
          {renderGroup("Staged", stagedFiles)}
          {renderGroup("Changes", changedFiles)}
          {renderGroup("Untracked", untrackedFiles)}
          {renderGroup("Conflicts", conflictFiles)}
          {visibleFiles.length === 0 && !loading && (
            <p className="px-1 text-[11px] text-slate-600">
              {status ? "No changes. Working tree clean." : "No status yet."}
            </p>
          )}
          {truncatedCount > 0 && (
            <p className="px-1 text-[10px] text-slate-600">…and {truncatedCount} more</p>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {diffLoading ? (
              <p className="text-[11px] text-slate-500">Loading diff…</p>
            ) : diff ? (
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <p className="truncate font-mono text-[11px] text-slate-200">{diff.path}</p>
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">
                    {diff.status}
                  </span>
                  <span className="font-mono text-[10px] text-emerald-400">+{diff.additions}</span>
                  <span className="font-mono text-[10px] text-red-400">−{diff.deletions}</span>
                  {selectedPath && (
                    <span className="ml-auto flex gap-1">
                      <button
                        type="button"
                        onClick={() => void handleSelectFile(selectedPath, false)}
                        aria-pressed={!stagedView}
                        className={`rounded px-1.5 py-0.5 text-[10px] ${
                          !stagedView
                            ? "bg-indigo-700 text-white"
                            : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                        }`}
                      >
                        Unstaged
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleSelectFile(selectedPath, true)}
                        aria-pressed={stagedView}
                        className={`rounded px-1.5 py-0.5 text-[10px] ${
                          stagedView
                            ? "bg-indigo-700 text-white"
                            : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                        }`}
                      >
                        Staged
                      </button>
                    </span>
                  )}
                </div>
                {diff.binary ? (
                  <p className="text-[11px] text-slate-500">Binary file — preview unavailable</p>
                ) : diff.hunks.length === 0 ? (
                  <p className="text-[11px] text-slate-600">No diff hunks.</p>
                ) : (
                  <pre className="whitespace-pre-wrap font-mono text-[10px] leading-4">
                    {diff.hunks.map((hunk, hi) => (
                      <span key={hi}>
                        {hunk.header && <span className="block text-slate-500">{hunk.header}</span>}
                        {hunk.lines.map((line, li) => (
                          <span
                            key={li}
                            className={`block ${
                              line.kind === "add"
                                ? "bg-emerald-950/50 text-emerald-300"
                                : line.kind === "del"
                                  ? "bg-red-950/50 text-red-300"
                                  : "text-slate-500"
                            }`}
                          >
                            {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                            {line.text}
                          </span>
                        ))}
                      </span>
                    ))}
                  </pre>
                )}
              </div>
            ) : (
              <p className="text-[11px] text-slate-600">
                {selectedPath
                  ? `Diff unavailable for ${selectedPath}.`
                  : "Select a changed file to preview its diff."}
              </p>
            )}
          </div>

          <div className="shrink-0 border-t border-slate-800 px-4 py-2">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Commit ({stagedCount} staged)
            </p>
            <textarea
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              maxLength={32768}
              rows={3}
              placeholder="Commit message…"
              aria-label="Commit message"
              className="w-full resize-none rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            {actionError && <p className="mt-1 text-[11px] text-red-300">{actionError}</p>}
            <div className="mt-1.5 flex justify-end">
              <button
                type="button"
                onClick={() => void handleCommit()}
                disabled={!canCommit}
                className="rounded-lg bg-indigo-700 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-indigo-600 disabled:opacity-40"
              >
                {busy ? "Working…" : "Commit"}
              </button>
            </div>
          </div>
        </div>

        <div className="hidden w-64 shrink-0 flex-col overflow-y-auto border-l border-slate-800 px-3 py-3 lg:flex">
          <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            History ({commits.length})
          </p>
          {commits.length === 0 ? (
            <p className="mb-3 px-1 text-[11px] text-slate-600">No commits yet.</p>
          ) : (
            <ul className="mb-3 space-y-1">
              {commits.slice(0, 50).map((commit) => (
                <li key={commit.hash} className="rounded bg-slate-800/60 px-2 py-1">
                  <p className="truncate font-mono text-[10px] text-indigo-300">
                    {commit.hash.slice(0, 7)} · {commit.subject}
                  </p>
                  {(commit.author || commit.date) && (
                    <p className="mt-0.5 truncate text-[10px] text-slate-500">
                      {[commit.author, commit.date].filter(Boolean).join(" · ")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Branches ({branches.length})
          </p>
          {branches.length === 0 ? (
            <p className="px-1 text-[11px] text-slate-600">No branches.</p>
          ) : (
            <ul className="space-y-0.5">
              {branches.slice(0, 100).map((branch) => (
                <li
                  key={branch.name}
                  className="flex items-center justify-between rounded px-1.5 py-0.5 font-mono text-[11px] text-slate-300"
                >
                  <span className="truncate">{branch.name}</span>
                  {branch.current && (
                    <span className="ml-1 shrink-0 rounded bg-emerald-800 px-1 py-px text-[9px] text-emerald-100">
                      current
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
