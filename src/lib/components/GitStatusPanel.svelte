<script lang="ts">
  import { onDestroy } from "svelte";
  import { socket } from "../socket.svelte";
  import type { GitStatusResult } from "../types";

  type Props = {
    threadId?: string | null;
    initialPath?: string;
    anchorId?: string;
    autoRefreshKey?: string | number | null;
    onResolvedRepoPath?: (repoRoot: string) => void;
  };

  const {
    threadId = null,
    initialPath = "",
    anchorId,
    autoRefreshKey = null,
    onResolvedRepoPath,
  }: Props = $props();

  let repoPath = $state("");
  let status = $state<GitStatusResult | null>(null);
  let selectedPaths = $state<Set<string>>(new Set());
  let loading = $state(false);
  let error = $state<string | null>(null);
  let commitMessage = $state("");
  let commitBusy = $state(false);
  let pushBusy = $state(false);
  let revertBusy = $state(false);
  let pushAfterCommit = $state(false);
  let actionMessage = $state<string | null>(null);

  let activeView = $state<"changes" | "history">("changes");

  let selectedDiffPath = $state<string | null>(null);
  let diffText = $state("");
  let diffLoading = $state(false);
  let diffError = $state<string | null>(null);
  let diffIsBinary = $state(false);
  let diffTooLarge = $state(false);
  let diffRequestId = 0;

  let graphText = $state("");
  let graphLoading = $state(false);
  let graphError = $state<string | null>(null);
  let graphTruncated = $state(false);
  let graphRequestId = 0;

  let initialAutoLoadedPath = "";
  let lastAutoRefreshSignature = "";
  let autoRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  const isBusy = $derived(loading || commitBusy || pushBusy || revertBusy);
  const selectedCount = $derived(selectedPaths.size);
  const allSelected = $derived.by(() => {
    if (!status || status.entries.length === 0) return false;
    return status.entries.every((entry) => selectedPaths.has(entry.path));
  });

  function clearAutoRefreshTimer() {
    if (!autoRefreshTimer) return;
    clearTimeout(autoRefreshTimer);
    autoRefreshTimer = null;
  }

  function scheduleAutoRefresh(delayMs = 250) {
    if (isBusy) return;
    clearAutoRefreshTimer();
    autoRefreshTimer = setTimeout(() => {
      autoRefreshTimer = null;
      void refreshStatus({ silent: true, keepActionMessage: true });
    }, delayMs);
  }

  onDestroy(() => {
    clearAutoRefreshTimer();
  });

  $effect(() => {
    if (!repoPath.trim() && initialPath.trim()) {
      repoPath = initialPath.trim();
    }
  });

  $effect(() => {
    const path = repoPath.trim();
    const initial = initialPath.trim();
    if (!path || !initial) return;
    if (path !== initial) return;
    if (initialAutoLoadedPath === path) return;
    initialAutoLoadedPath = path;
    scheduleAutoRefresh(0);
  });

  $effect(() => {
    const path = repoPath.trim();
    if (!path) return;
    const signature = `${autoRefreshKey ?? ""}|${path}|${anchorId ?? ""}`;
    if (signature === lastAutoRefreshSignature) return;
    lastAutoRefreshSignature = signature;
    if (autoRefreshKey == null || autoRefreshKey === "") return;
    scheduleAutoRefresh(220);
  });

  $effect(() => {
    if (activeView !== "history") return;
    if (graphText || graphLoading) return;
    void loadGitGraph({ silent: true });
  });

  function syncSelection(entries: GitStatusResult["entries"]) {
    if (entries.length === 0) {
      selectedPaths = new Set();
      return;
    }

    if (selectedPaths.size === 0) {
      selectedPaths = new Set(entries.map((entry) => entry.path));
      return;
    }

    const next = new Set<string>();
    for (const entry of entries) {
      if (selectedPaths.has(entry.path)) {
        next.add(entry.path);
      }
    }

    if (next.size === 0) {
      selectedPaths = new Set(entries.map((entry) => entry.path));
      return;
    }

    selectedPaths = next;
  }

  function syncDiffSelection(entries: GitStatusResult["entries"]) {
    if (!selectedDiffPath) return;
    const stillExists = entries.some((entry) => entry.path === selectedDiffPath);
    if (stillExists) return;
    selectedDiffPath = null;
    diffText = "";
    diffError = null;
    diffLoading = false;
    diffIsBinary = false;
    diffTooLarge = false;
  }

  async function refreshStatus(options?: { silent?: boolean; keepActionMessage?: boolean }): Promise<void> {
    const silent = options?.silent === true;
    const keepActionMessage = options?.keepActionMessage === true;

    if (!repoPath.trim()) {
      status = null;
      selectedPaths = new Set();
      if (!silent) {
        error = "Set absolute file or repository path first.";
      }
      return;
    }
    if (isBusy && silent) return;

    loading = true;
    if (!silent) {
      error = null;
      if (!keepActionMessage) actionMessage = null;
    }
    try {
      status = await socket.gitStatus(repoPath.trim(), anchorId);
      syncSelection(status.entries);
      syncDiffSelection(status.entries);
      const repoRoot = status.repoRoot.trim();
      if (repoRoot && onResolvedRepoPath) {
        onResolvedRepoPath(repoRoot);
      }
      if (activeView === "history") {
        void loadGitGraph({ silent: true, repoRoot });
      } else if (selectedDiffPath && status.entries.some((entry) => entry.path === selectedDiffPath)) {
        void loadFileDiff(selectedDiffPath, { silent: true, repoRoot });
      }
      if (!silent) {
        error = null;
      }
    } catch (err) {
      status = null;
      selectedPaths = new Set();
      error = err instanceof Error ? err.message : "Failed to read git status.";
    } finally {
      loading = false;
    }
  }

  async function ensureRepoRoot(): Promise<string | null> {
    const resolved = status?.repoRoot?.trim();
    if (resolved) return resolved;
    await refreshStatus({ silent: true, keepActionMessage: true });
    return status?.repoRoot?.trim() || null;
  }

  async function loadFileDiff(path: string, options?: { silent?: boolean; repoRoot?: string }): Promise<void> {
    const silent = options?.silent === true;
    const repoRoot = options?.repoRoot?.trim() || status?.repoRoot?.trim();
    if (!repoRoot) {
      if (!silent) error = "Refresh status first to resolve repository root.";
      return;
    }

    selectedDiffPath = path;
    diffLoading = true;
    if (!silent) {
      error = null;
      diffError = null;
    }
    const requestId = ++diffRequestId;

    try {
      const result = await socket.gitDiff(repoRoot, path, anchorId);
      if (requestId !== diffRequestId) return;
      diffText = result.diff || "";
      diffError = null;
      diffIsBinary = Boolean(result.isBinary);
      diffTooLarge = Boolean(result.tooLarge);
    } catch (err) {
      if (requestId !== diffRequestId) return;
      diffText = "";
      diffIsBinary = false;
      diffTooLarge = false;
      diffError = err instanceof Error ? err.message : "Failed to load file diff.";
    } finally {
      if (requestId === diffRequestId) {
        diffLoading = false;
      }
    }
  }

  async function loadGitGraph(options?: { silent?: boolean; repoRoot?: string }): Promise<void> {
    const silent = options?.silent === true;
    const repoRoot = options?.repoRoot?.trim() || await ensureRepoRoot();
    if (!repoRoot) {
      if (!silent) error = "Refresh status first to resolve repository root.";
      return;
    }

    graphLoading = true;
    if (!silent) {
      error = null;
      graphError = null;
    }
    const requestId = ++graphRequestId;

    try {
      const result = await socket.gitLogGraph(repoRoot, 300, anchorId);
      if (requestId !== graphRequestId) return;
      graphText = result.graph || "";
      graphError = null;
      graphTruncated = result.truncated;
    } catch (err) {
      if (requestId !== graphRequestId) return;
      graphText = "";
      graphTruncated = false;
      graphError = err instanceof Error ? err.message : "Failed to load git graph.";
    } finally {
      if (requestId === graphRequestId) {
        graphLoading = false;
      }
    }
  }

  function setView(nextView: "changes" | "history") {
    activeView = nextView;
    if (nextView === "history") {
      void loadGitGraph({ silent: true });
    }
  }

  function setAllSelected(nextChecked: boolean) {
    if (!status) return;
    if (!nextChecked) {
      selectedPaths = new Set();
      return;
    }
    selectedPaths = new Set(status.entries.map((entry) => entry.path));
  }

  function setPathSelected(path: string, nextChecked: boolean) {
    const next = new Set(selectedPaths);
    if (nextChecked) {
      next.add(path);
    } else {
      next.delete(path);
    }
    selectedPaths = next;
  }

  function getSelectedEntryPaths(): string[] {
    if (!status) return [];
    return status.entries
      .map((entry) => entry.path)
      .filter((path) => selectedPaths.has(path));
  }

  async function commitSelected(): Promise<void> {
    const repoRoot = status?.repoRoot?.trim();
    if (!repoRoot) {
      error = "Refresh status first to resolve repository root.";
      return;
    }
    if (!commitMessage.trim()) {
      error = "Commit message is required.";
      return;
    }

    const selected = getSelectedEntryPaths();
    if (selected.length === 0) {
      error = "Select at least one file to commit.";
      return;
    }

    commitBusy = true;
    error = null;
    actionMessage = null;
    try {
      const allSelectedNow = status ? selected.length === status.entries.length : false;
      const commitResult = await socket.gitCommit(
        repoRoot,
        commitMessage.trim(),
        allSelectedNow,
        anchorId,
        allSelectedNow ? undefined : selected,
      );
      let combinedOutput = commitResult.output || "Committed.";
      if (pushAfterCommit) {
        const pushResult = await socket.gitPush(repoRoot, undefined, undefined, anchorId);
        combinedOutput = `${combinedOutput}\n\n${pushResult.output || "Pushed."}`.trim();
      }
      commitMessage = "";
      actionMessage = combinedOutput;
      await refreshStatus({ silent: true, keepActionMessage: true });
    } catch (err) {
      error = err instanceof Error ? err.message : "Commit failed.";
    } finally {
      commitBusy = false;
    }
  }

  async function pushChanges(): Promise<void> {
    const repoRoot = status?.repoRoot?.trim();
    if (!repoRoot) {
      error = "Refresh status first to resolve repository root.";
      return;
    }

    pushBusy = true;
    error = null;
    actionMessage = null;
    try {
      const result = await socket.gitPush(repoRoot, undefined, undefined, anchorId);
      actionMessage = result.output || "Pushed.";
      await refreshStatus({ silent: true, keepActionMessage: true });
    } catch (err) {
      error = err instanceof Error ? err.message : "Push failed.";
    } finally {
      pushBusy = false;
    }
  }

  async function revertSelected(): Promise<void> {
    const repoRoot = status?.repoRoot?.trim();
    if (!repoRoot) {
      error = "Refresh status first to resolve repository root.";
      return;
    }

    const selected = getSelectedEntryPaths();
    if (selected.length === 0) {
      error = "Select at least one file to revert.";
      return;
    }
    if (!confirm(`Revert selected changes in ${selected.length} file(s)?`)) return;

    revertBusy = true;
    error = null;
    actionMessage = null;
    try {
      const result = await socket.gitRevert(repoRoot, anchorId, selected);
      actionMessage = result.output || `Reverted ${result.reverted} file(s).`;
      await refreshStatus({ silent: true, keepActionMessage: true });
    } catch (err) {
      error = err instanceof Error ? err.message : "Revert failed.";
    } finally {
      revertBusy = false;
    }
  }

  async function revertSingle(path: string): Promise<void> {
    const repoRoot = status?.repoRoot?.trim();
    if (!repoRoot) {
      error = "Refresh status first to resolve repository root.";
      return;
    }
    if (!confirm(`Revert changes in ${path}?`)) return;

    revertBusy = true;
    error = null;
    actionMessage = null;
    try {
      const result = await socket.gitRevert(repoRoot, anchorId, [path]);
      actionMessage = result.output || `Reverted ${path}.`;
      await refreshStatus({ silent: true, keepActionMessage: true });
    } catch (err) {
      error = err instanceof Error ? err.message : "Revert failed.";
    } finally {
      revertBusy = false;
    }
  }

  async function revertAll(): Promise<void> {
    const repoRoot = status?.repoRoot?.trim();
    if (!repoRoot) {
      error = "Refresh status first to resolve repository root.";
      return;
    }
    if (!confirm("Revert all local changes and remove all untracked files?")) return;

    revertBusy = true;
    error = null;
    actionMessage = null;
    try {
      const result = await socket.gitRevert(repoRoot, anchorId);
      actionMessage = result.output || "All changes reverted.";
      await refreshStatus({ silent: true, keepActionMessage: true });
    } catch (err) {
      error = err instanceof Error ? err.message : "Revert all failed.";
    } finally {
      revertBusy = false;
    }
  }
</script>

<section class="git-panel stack" aria-live="polite">
  <header class="panel-head row">
    <div class="panel-title-wrap stack">
      <span class="panel-kicker">Thread data</span>
      <h2>Git Changes</h2>
      {#if threadId}
        <p class="panel-subtle">Thread {threadId.slice(0, 8)}</p>
      {/if}
    </div>
    <button type="button" class="refresh-btn" onclick={() => void refreshStatus()} disabled={isBusy}>
      {loading ? "Refreshing..." : "Refresh"}
    </button>
  </header>

  <div class="row path-row">
    <input
      class="path-input"
      type="text"
      placeholder="D:\\project\\repo (or absolute file path)"
      bind:value={repoPath}
      onkeydown={(e) => {
        if (e.key === "Enter") void refreshStatus();
      }}
    />
  </div>

  {#if status}
    <div class="status-line row">
      <span class="chip">{status.clean ? "clean" : "dirty"}</span>
      <span class="chip">{status.branch ? `branch ${status.branch}` : "detached"}</span>
      <span class="chip">{status.repoRoot}</span>
      <span class="chip">changes {status.entries.length}</span>
      <span class="chip">selected {selectedCount}</span>
    </div>

    <div class="view-tabs row">
      <button type="button" class="tab-btn" class:active={activeView === "changes"} onclick={() => setView("changes")}>
        Changes
      </button>
      <button type="button" class="tab-btn" class:active={activeView === "history"} onclick={() => setView("history")}>
        History
      </button>
    </div>

    {#if activeView === "changes"}
      {#if status.entries.length > 0}
        <div class="selection-toolbar row">
          <label class="select-all row">
            <input
              type="checkbox"
              checked={allSelected}
              onchange={(e) => setAllSelected((e.currentTarget as HTMLInputElement).checked)}
              disabled={isBusy}
            />
            <span>Select all</span>
          </label>
          <button type="button" class="mini-btn danger" onclick={() => void revertSelected()} disabled={isBusy || selectedCount === 0}>
            Revert selected
          </button>
          <button type="button" class="mini-btn danger" onclick={() => void revertAll()} disabled={isBusy}>
            Revert all
          </button>
        </div>

        <div class="entries">
          {#each status.entries as entry (entry.path + entry.rawStatus)}
            <div class="entry row" class:diff-active={selectedDiffPath === entry.path}>
              <label class="entry-select row">
                <input
                  type="checkbox"
                  checked={selectedPaths.has(entry.path)}
                  onchange={(e) => setPathSelected(entry.path, (e.currentTarget as HTMLInputElement).checked)}
                  disabled={isBusy}
                />
              </label>
              <span class="entry-status">{entry.rawStatus}</span>
              <span class="entry-path">{entry.path}</span>
              <div class="entry-actions row">
                <button type="button" class="entry-diff-btn" onclick={() => void loadFileDiff(entry.path)} disabled={isBusy}>
                  Diff
                </button>
                <button type="button" class="entry-revert-btn" onclick={() => void revertSingle(entry.path)} disabled={isBusy}>
                  Revert
                </button>
              </div>
            </div>
          {/each}
        </div>

        <div class="diff-preview stack">
          <div class="diff-preview-head row">
            <span class="chip">{selectedDiffPath ? selectedDiffPath : "select file for diff"}</span>
            {#if diffIsBinary}
              <span class="chip">binary</span>
            {/if}
            {#if diffTooLarge}
              <span class="chip">truncated</span>
            {/if}
          </div>
          {#if diffLoading}
            <p class="hint">Loading diff...</p>
          {:else if diffError}
            <p class="hint hint-error">{diffError}</p>
          {:else if selectedDiffPath}
            <pre class="diff-output">{diffText || "No diff payload for this path."}</pre>
          {:else}
            <p class="hint">Pick a file and press Diff to preview changes.</p>
          {/if}
        </div>

        <div class="actions stack">
          <input
            class="commit-input"
            type="text"
            placeholder="Commit message"
            bind:value={commitMessage}
            onkeydown={(e) => {
              if (e.key === "Enter" && !commitBusy) void commitSelected();
            }}
          />
          <label class="push-after row">
            <input type="checkbox" bind:checked={pushAfterCommit} disabled={isBusy} />
            <span>Push after commit</span>
          </label>
          <div class="row action-buttons">
            <button type="button" class="action-btn" onclick={() => void commitSelected()} disabled={isBusy || selectedCount === 0}>
              {commitBusy ? "Committing..." : "Commit Selected"}
            </button>
            <button type="button" class="action-btn" onclick={() => void pushChanges()} disabled={isBusy}>
              {pushBusy ? "Pushing..." : "Push"}
            </button>
          </div>
        </div>
      {:else}
        <p class="hint">No local changes in this repository.</p>
      {/if}
    {:else}
      <div class="history-toolbar row">
        <button type="button" class="mini-btn" onclick={() => void loadGitGraph()} disabled={graphLoading}>
          {graphLoading ? "Loading..." : "Reload graph"}
        </button>
      </div>

      {#if graphLoading && !graphText}
        <p class="hint">Loading git graph...</p>
      {:else if graphError}
        <p class="hint hint-error">{graphError}</p>
      {:else if !graphText}
        <p class="hint">No commits yet.</p>
      {:else}
        <pre class="graph-output">{graphText}</pre>
        {#if graphTruncated}
          <p class="hint">Graph output truncated to latest commits.</p>
        {/if}
      {/if}
    {/if}
  {/if}

  {#if error}
    <p class="hint hint-error">{error}</p>
  {/if}
  {#if actionMessage}
    <p class="hint">{actionMessage}</p>
  {/if}
</section>

<style>
  .git-panel {
    --stack-gap: var(--space-sm);
    border: 1px solid color-mix(in srgb, var(--cli-border) 70%, transparent);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--cli-bg-elevated) 86%, transparent);
    padding: var(--space-md);
  }

  .panel-head {
    justify-content: space-between;
    align-items: flex-start;
  }

  .panel-title-wrap {
    --stack-gap: 0.14rem;
  }

  .panel-kicker {
    font-family: var(--font-mono);
    font-size: 0.66rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--cli-text-muted);
  }

  h2 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 1.26rem;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--cli-text);
  }

  .panel-subtle {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--cli-text-muted);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .refresh-btn,
  .action-btn,
  .mini-btn,
  .entry-diff-btn,
  .entry-revert-btn {
    padding: var(--space-xs) var(--space-sm);
    background: transparent;
    border: 1px solid color-mix(in srgb, var(--cli-border) 74%, transparent);
    border-radius: var(--radius-md);
    color: var(--cli-text);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    cursor: pointer;
  }

  .refresh-btn:hover:enabled,
  .action-btn:hover:enabled,
  .mini-btn:hover:enabled,
  .entry-diff-btn:hover:enabled,
  .entry-revert-btn:hover:enabled {
    border-color: var(--cli-prefix-agent);
    background: color-mix(in srgb, var(--cli-prefix-agent) 10%, transparent);
  }

  .mini-btn.danger:hover:enabled,
  .entry-revert-btn:hover:enabled {
    border-color: var(--cli-error);
    background: color-mix(in srgb, var(--cli-error) 10%, transparent);
  }

  .refresh-btn:disabled,
  .action-btn:disabled,
  .mini-btn:disabled,
  .entry-diff-btn:disabled,
  .entry-revert-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .path-row {
    --row-gap: var(--space-sm);
  }

  .path-input,
  .commit-input {
    width: 100%;
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--cli-border);
    border-radius: var(--radius-md);
    background: var(--cli-bg);
    color: var(--cli-text);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .status-line {
    --row-gap: var(--space-xs);
    flex-wrap: wrap;
  }

  .view-tabs {
    --row-gap: var(--space-xs);
  }

  .tab-btn {
    padding: 0.28rem 0.55rem;
    border: 1px solid color-mix(in srgb, var(--cli-border) 72%, transparent);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--cli-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    cursor: pointer;
  }

  .tab-btn.active {
    color: var(--cli-text);
    border-color: var(--cli-prefix-agent);
    background: color-mix(in srgb, var(--cli-prefix-agent) 12%, transparent);
  }

  .chip {
    border: 1px solid var(--cli-border);
    border-radius: 999px;
    padding: 0.08rem 0.35rem;
    font-family: var(--font-mono);
    font-size: 0.64rem;
    color: var(--cli-text-dim);
  }

  .selection-toolbar {
    --row-gap: var(--space-sm);
    align-items: center;
    flex-wrap: wrap;
  }

  .select-all {
    --row-gap: 0.4rem;
    align-items: center;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--cli-text);
  }

  .entries {
    max-height: 280px;
    overflow: auto;
    border: 1px solid color-mix(in srgb, var(--cli-border) 60%, transparent);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--cli-bg) 80%, transparent);
  }

  .entry {
    --row-gap: var(--space-sm);
    padding: 0.32rem 0.48rem;
    border-bottom: 1px solid color-mix(in srgb, var(--cli-border) 40%, transparent);
    align-items: center;
  }

  .entry.diff-active {
    background: color-mix(in srgb, var(--cli-prefix-agent) 7%, transparent);
  }

  .entry:last-child {
    border-bottom: none;
  }

  .entry-select {
    --row-gap: 0.3rem;
    align-items: center;
  }

  .entry-status {
    width: 2rem;
    color: var(--cli-prefix-agent);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .entry-path {
    color: var(--cli-text);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
    flex: 1;
  }

  .entry-actions {
    --row-gap: var(--space-xs);
    flex-shrink: 0;
  }

  .entry-revert-btn {
    flex-shrink: 0;
  }

  .diff-preview {
    --stack-gap: var(--space-xs);
    border: 1px solid color-mix(in srgb, var(--cli-border) 60%, transparent);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--cli-bg) 80%, transparent);
    padding: var(--space-sm);
  }

  .diff-preview-head {
    --row-gap: var(--space-xs);
    flex-wrap: wrap;
  }

  .history-toolbar {
    --row-gap: var(--space-xs);
  }

  .diff-output,
  .graph-output {
    margin: 0;
    max-height: 320px;
    overflow: auto;
    border: 1px solid color-mix(in srgb, var(--cli-border) 56%, transparent);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--cli-bg-elevated) 72%, transparent);
    padding: var(--space-sm);
    color: var(--cli-text);
    font-family: var(--font-mono);
    font-size: 0.72rem;
    line-height: 1.45;
    white-space: pre;
  }

  .actions {
    --stack-gap: var(--space-xs);
  }

  .push-after {
    --row-gap: 0.4rem;
    align-items: center;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--cli-text);
  }

  .action-buttons {
    --row-gap: var(--space-xs);
  }

  .hint {
    margin: 0;
    color: var(--cli-text-muted);
    font-family: var(--font-sans);
    font-size: 0.8rem;
    line-height: 1.45;
    white-space: pre-wrap;
  }

  .hint-error {
    color: var(--cli-error);
  }
</style>
