<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { socket } from "../socket.svelte";
  import { worktrees } from "../worktrees.svelte";

  type Step = "project" | "worktree";
  const SEARCH_START_STORAGE_KEY = "codex_remote_worktree_search_start";
  const WORKTREE_ROOT_STORAGE_KEY = "codex_remote_worktree_root_dir";

  interface Props {
    open: boolean;
    project: string;
  }

  const { open, project }: Props = $props();

  const dispatch = createEventDispatcher<{
    close: void;
    confirm: { project: string };
  }>();

  let step = $state<Step>("project");

  // Directory browser state
  let dirs = $state<string[]>([]);
  let roots = $state<string[]>([]);
  let currentPath = $state("");
  let parentPath = $state("");
  let browseLoading = $state(false);
  let browseError = $state<string | null>(null);
  let browseRequestId = 0;
  let searchStartPath = $state(readStoredPath(SEARCH_START_STORAGE_KEY));

  // Worktree action state
  let actionError = $state<string | null>(null);
  let actionMessage = $state<string | null>(null);
  let worktreeRootDir = $state(readStoredPath(WORKTREE_ROOT_STORAGE_KEY));
  let newWorktreePath = $state("");

  const selectedPath = $derived(
    step === "worktree"
      ? worktrees.selectedWorktreePath || currentPath
      : currentPath
  );

  const canNext = $derived(worktrees.isGitRepo && !worktrees.loading);
  const canSelect = $derived(
    step === "worktree"
      ? !!selectedPath.trim()
      : !!currentPath.trim()
  );

  function readStoredPath(key: string): string {
    if (typeof localStorage === "undefined") return "";
    try {
      return localStorage.getItem(key)?.trim() ?? "";
    } catch {
      return "";
    }
  }

  function writeStoredPath(key: string, value: string) {
    if (typeof localStorage === "undefined") return;
    try {
      if (value) {
        localStorage.setItem(key, value);
      } else {
        localStorage.removeItem(key);
      }
    } catch {
      // ignore storage errors
    }
  }

  function saveSearchStartPath(path: string) {
    const trimmed = path.trim();
    searchStartPath = trimmed;
    writeStoredPath(SEARCH_START_STORAGE_KEY, trimmed);
  }

  function saveWorktreeRootDir(path: string) {
    const trimmed = path.trim();
    worktreeRootDir = trimmed;
    writeStoredPath(WORKTREE_ROOT_STORAGE_KEY, trimmed);
  }

  async function browse(path?: string) {
    const requestId = ++browseRequestId;
    browseLoading = true;
    browseError = null;
    try {
      const result = await socket.listDirs(path, path ? undefined : searchStartPath || undefined);
      if (requestId !== browseRequestId) return;
      dirs = result.dirs;
      currentPath = result.current;
      parentPath = result.parent;
      roots = result.roots ?? [];
    } catch (err) {
      if (requestId !== browseRequestId) return;
      browseError = err instanceof Error ? err.message : "Failed to list directories";
      dirs = [];
    } finally {
      if (requestId !== browseRequestId) return;
      browseLoading = false;
    }
  }

  async function browseAndInspect(path?: string) {
    await browse(path);
    if (currentPath) {
      await worktrees.inspect(currentPath);
    }
  }

  function navigateTo(dirName: string) {
    const fullPath = currentPath.endsWith("/")
      ? currentPath + dirName
      : currentPath + "/" + dirName;
    void browseAndInspect(fullPath);
  }

  function navigateUp() {
    if (parentPath && parentPath !== currentPath) {
      void browseAndInspect(parentPath);
    }
  }

  function openSearchStart() {
    const value = searchStartPath.trim();
    saveSearchStartPath(value);
    void browseAndInspect(value || undefined);
  }

  function setSearchStartFromCurrent() {
    if (!currentPath.trim()) return;
    saveSearchStartPath(currentPath.trim());
  }

  function jumpToRoot(root: string) {
    saveSearchStartPath(root);
    void browseAndInspect(root);
  }

  function setWorktreeRootFromCurrent() {
    if (!currentPath.trim()) return;
    saveWorktreeRootDir(currentPath.trim());
  }

  function goNext() {
    if (!canNext) return;
    step = "worktree";
  }

  function goBack() {
    step = "project";
  }

  async function createWorktree() {
    if (!worktrees.repoRoot || worktrees.mutating) return;
    actionError = null;
    actionMessage = null;
    try {
      const path = newWorktreePath.trim();
      const rootDir = worktreeRootDir.trim();
      saveWorktreeRootDir(rootDir);
      await worktrees.create({
        ...(path ? { path } : {}),
        ...(rootDir ? { rootDir } : {}),
      });
      if (path) {
        newWorktreePath = "";
      }
      actionMessage = "Created worktree";
    } catch (err) {
      actionError = err instanceof Error ? err.message : "Failed to create worktree";
    }
  }

  function closeModal() {
    dispatch("close");
  }

  function confirmSelection() {
    if (step === "project") {
      if (!currentPath.trim()) return;
      dispatch("confirm", { project: currentPath.trim() });
    } else {
      const path = selectedPath.trim();
      if (!path) return;
      dispatch("confirm", { project: path });
    }
  }

  function handleWindowKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") closeModal();
  }

  $effect(() => {
    if (!open) return;
    actionError = null;
    actionMessage = null;
    currentPath = project;
    roots = [];
    newWorktreePath = "";
    searchStartPath = readStoredPath(SEARCH_START_STORAGE_KEY);
    worktreeRootDir = readStoredPath(WORKTREE_ROOT_STORAGE_KEY);

    if (project) {
      void browseAndInspect(project).then(() => {
        step = worktrees.isGitRepo ? "worktree" : "project";
      });
    } else {
      step = "project";
      void browse();
    }
  });
</script>

<svelte:window onkeydown={handleWindowKeydown} />

{#if open}
  <button type="button" class="modal-backdrop" aria-label="Close" onclick={closeModal}></button>
  <div class="modal" role="dialog" aria-modal="true" tabindex="-1">
    <div class="modal-header split">
      <div class="step-indicators row">
        <button
          type="button"
          class="step-tab"
          class:active={step === "project"}
          onclick={goBack}
        >
          Project
        </button>
        <span class="step-arrow">›</span>
        <button
          type="button"
          class="step-tab"
          class:active={step === "worktree"}
          disabled={!canNext}
          onclick={goNext}
        >
          Worktree
        </button>
      </div>
      <button type="button" class="modal-close" onclick={closeModal}>×</button>
    </div>

    <div class="modal-body stack">
      {#if step === "project"}
        <div class="path-tools stack">
          <label class="path-label" for="search-start-input">Search start directory</label>
          <div class="path-input-row row">
            <input
              id="search-start-input"
              class="path-input"
              type="text"
              bind:value={searchStartPath}
              placeholder="C:\\Projects or /Users/name/projects"
            />
            <button type="button" class="tiny-btn" onclick={openSearchStart}>Open</button>
            <button type="button" class="tiny-btn" onclick={setSearchStartFromCurrent}>Use current</button>
          </div>
          {#if roots.length > 0}
            <div class="roots row">
              {#each roots as root}
                <button type="button" class="root-btn" onclick={() => jumpToRoot(root)}>{root}</button>
              {/each}
            </div>
          {/if}
        </div>

        <div class="dir-browser">
          <div class="dir-header">
            <span class="dir-path" title={currentPath}>{currentPath || "/"}</span>
            {#if worktrees.loading}
              <span class="dir-hint">inspecting...</span>
            {/if}
          </div>
          {#if browseLoading}
            <div class="dir-status">Loading...</div>
          {:else if browseError}
            <div class="dir-status dir-error">{browseError}</div>
          {:else}
            <ul class="dir-list">
              {#if parentPath && parentPath !== currentPath}
                <li>
                  <button type="button" class="dir-item" onclick={navigateUp}>..</button>
                </li>
              {/if}
              {#each dirs as dir}
                <li>
                  <button type="button" class="dir-item" onclick={() => navigateTo(dir)}>
                    {dir}/
                  </button>
                </li>
              {/each}
              {#if dirs.length === 0}
                <li class="dir-status">No subdirectories</li>
              {/if}
            </ul>
          {/if}
        </div>

        {#if worktrees.isGitRepo}
          <div class="status-msg status-ok">Git repository detected</div>
        {/if}
      {:else}
        {#if worktrees.loading}
          <div class="status-msg">Loading...</div>
        {:else}
          <div class="path-tools stack">
            <label class="path-label" for="worktree-root-input">New worktree root (optional)</label>
            <div class="path-input-row row">
              <input
                id="worktree-root-input"
                class="path-input"
                type="text"
                bind:value={worktreeRootDir}
                placeholder="D:\\codex-worktrees or /Volumes/worktrees"
              />
              <button type="button" class="tiny-btn" onclick={setWorktreeRootFromCurrent}>Use current</button>
            </div>
            <label class="path-label" for="worktree-path-input">Exact new worktree path (optional)</label>
            <input
              id="worktree-path-input"
              class="path-input"
              type="text"
              bind:value={newWorktreePath}
              placeholder="D:\\codex-worktrees\\repo\\branch-name"
            />
          </div>

          <ul class="worktree-list">
            {#each worktrees.worktrees as wt}
              <li class="worktree-item" class:selected={wt.path === worktrees.selectedWorktreePath}>
                <button
                  type="button"
                  class="worktree-select"
                  onclick={() => worktrees.select(wt.path)}
                >
                  <span class="worktree-branch">{wt.branch || "detached"}</span>
                  <span class="worktree-path" title={wt.path}>{wt.path}</span>
                </button>
              </li>
            {/each}
          </ul>

          <button type="button" class="small-btn" onclick={createWorktree} disabled={worktrees.mutating}>
            + New from HEAD
          </button>
        {/if}
      {/if}

      {#if actionError || worktrees.error}
        <div class="status-msg status-error">{actionError || worktrees.error}</div>
      {/if}
      {#if actionMessage}
        <div class="status-msg status-ok">{actionMessage}</div>
      {/if}
    </div>

    <div class="modal-footer split">
      <button type="button" class="cancel-btn" onclick={closeModal}>Cancel</button>
      <div class="row footer-actions">
        {#if step === "project"}
          {#if canNext}
            <button type="button" class="confirm-btn" onclick={goNext}>
              Next
            </button>
          {:else}
            <button type="button" class="confirm-btn" onclick={confirmSelection} disabled={!canSelect}>
              Select
            </button>
          {/if}
        {:else}
          <button type="button" class="back-btn" onclick={goBack}>Back</button>
          <button type="button" class="confirm-btn" onclick={confirmSelection} disabled={!canSelect}>
            Select
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 500;
    border: none;
    cursor: default;
    animation: fadeIn 0.1s ease;
  }

  .modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 501;
    width: calc(100% - var(--space-md) * 2);
    max-width: 480px;
    background: var(--cli-bg-elevated);
    border: 1px solid var(--cli-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-popover);
    display: flex;
    flex-direction: column;
    max-height: 80vh;
  }

  .modal-header {
    --split-gap: var(--space-sm);
    padding: var(--space-sm) var(--space-md);
    border-bottom: 1px solid var(--cli-border);
  }

  .step-indicators {
    --row-gap: var(--space-xs);
    align-items: center;
  }

  .step-tab {
    padding: 0;
    background: transparent;
    border: none;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--cli-text-muted);
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .step-tab.active {
    color: var(--cli-text);
  }

  .step-tab:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .step-arrow {
    font-size: var(--text-xs);
    color: var(--cli-text-muted);
  }

  .modal-close {
    padding: 0;
    width: 1.5rem;
    height: 1.5rem;
    display: inline-grid;
    place-items: center;
    background: transparent;
    border: none;
    color: var(--cli-text-muted);
    font-size: var(--text-base);
    cursor: pointer;
    border-radius: var(--radius-sm);
  }

  .modal-close:hover {
    background: var(--cli-bg-hover);
    color: var(--cli-text);
  }

  .modal-body {
    --stack-gap: var(--space-sm);
    padding: var(--space-md);
    overflow-y: auto;
    flex: 1;
  }

  .path-tools {
    --stack-gap: var(--space-xs);
  }

  .path-label {
    font-family: var(--font-mono);
    font-size: 0.66rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--cli-text-muted);
  }

  .path-input-row {
    --row-gap: var(--space-xs);
    align-items: center;
  }

  .path-input {
    flex: 1;
    min-width: 0;
    padding: var(--space-xs) var(--space-sm);
    border: 1px solid var(--cli-border);
    border-radius: var(--radius-sm);
    background: var(--cli-bg);
    color: var(--cli-text);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .path-input:focus {
    outline: none;
    border-color: var(--cli-prefix-agent);
  }

  .roots {
    --row-gap: var(--space-xs);
    flex-wrap: wrap;
  }

  .root-btn,
  .tiny-btn {
    padding: 0.3rem 0.5rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--cli-border);
    background: transparent;
    color: var(--cli-text-dim);
    font-family: var(--font-mono);
    font-size: 0.66rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    cursor: pointer;
    white-space: nowrap;
  }

  .root-btn:hover,
  .tiny-btn:hover {
    color: var(--cli-text);
    border-color: var(--cli-text-muted);
  }

  /* Directory browser (step 1) */

  .dir-browser {
    border: 1px solid var(--cli-border);
    border-radius: var(--radius-sm);
    background: var(--cli-bg);
    max-height: 280px;
    display: flex;
    flex-direction: column;
  }

  .dir-header {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-xs) var(--space-sm);
    border-bottom: 1px solid var(--cli-border);
  }

  .dir-path {
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    color: var(--cli-text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .dir-hint {
    font-size: var(--text-xs);
    color: var(--cli-text-muted);
    flex-shrink: 0;
  }

  .dir-list {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    flex: 1;
  }

  .dir-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: var(--space-xs) var(--space-sm);
    background: transparent;
    border: none;
    color: var(--cli-text);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .dir-item:hover {
    background: var(--cli-selection);
  }

  .dir-status {
    padding: var(--space-sm);
    font-size: var(--text-xs);
    color: var(--cli-text-muted);
  }

  .dir-error {
    color: var(--cli-error);
  }

  /* Worktree list (step 2) */

  .worktree-list {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
  }

  .worktree-item {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    margin-bottom: var(--space-xs);
  }

  .worktree-item.selected {
    border-color: var(--cli-prefix-agent);
    background: color-mix(in srgb, var(--cli-prefix-agent) 10%, transparent);
  }

  .worktree-select {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    align-items: flex-start;
    text-align: left;
    padding: var(--space-xs) var(--space-sm);
    background: transparent;
    border: none;
    color: var(--cli-text);
    cursor: pointer;
  }

  .worktree-branch {
    font-size: var(--text-xs);
    color: var(--cli-text);
  }

  .worktree-path {
    font-size: var(--text-xs);
    color: var(--cli-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    width: 100%;
  }

  /* Buttons */

  .small-btn,
  .cancel-btn,
  .back-btn,
  .confirm-btn {
    padding: var(--space-xs) var(--space-sm);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .small-btn,
  .cancel-btn,
  .back-btn {
    background: transparent;
    color: var(--cli-text-dim);
    border: 1px solid var(--cli-border);
  }

  .confirm-btn {
    background: var(--cli-prefix-agent);
    border: none;
    color: var(--cli-bg);
  }

  .small-btn:disabled,
  .cancel-btn:disabled,
  .back-btn:disabled,
  .confirm-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .status-msg {
    font-size: var(--text-xs);
    color: var(--cli-text-muted);
  }

  .status-error {
    color: var(--cli-error);
  }

  .status-ok {
    color: var(--cli-prefix-agent);
  }

  .modal-footer {
    --split-gap: var(--space-sm);
    padding: var(--space-sm) var(--space-md);
    border-top: 1px solid var(--cli-border);
  }

  .footer-actions {
    --row-gap: var(--space-sm);
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
