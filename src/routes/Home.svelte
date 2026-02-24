<script lang="ts">
  import { socket } from "../lib/socket.svelte";
  import { threads } from "../lib/threads.svelte";
  import { theme } from "../lib/theme.svelte";
  import { models } from "../lib/models.svelte";
  import { worktrees } from "../lib/worktrees.svelte";
  import AppHeader from "../lib/components/AppHeader.svelte";
  import HomeTaskComposer from "../lib/components/HomeTaskComposer.svelte";
  import WorktreeModal from "../lib/components/WorktreeModal.svelte";
  import RecentSessionsList from "../lib/components/RecentSessionsList.svelte";
  import type { ModeKind } from "../lib/types";

  const themeIcons = { system: "◐", light: "○", dark: "●" } as const;
  const RECENT_LIMIT = 5;
  const PANE_COUNT_OPTIONS = [2, 4, 8] as const;
  const MAX_PANES = 8;

  type PaneCount = (typeof PANE_COUNT_OPTIONS)[number];

  interface ComposerPane {
    id: number;
    task: string;
    project: string;
    mode: ModeKind;
    selectedModel: string;
    isCreating: boolean;
    pendingStartToken: number | null;
    submitError: string | null;
  }

  const recentThreads = $derived(threads.list.slice(0, RECENT_LIMIT));
  const hasMoreThreads = $derived(threads.list.length > RECENT_LIMIT);
  const isConnected = $derived(socket.status === "connected");

  let paneCount = $state<PaneCount>(2);
  let panes = $state<ComposerPane[]>(createInitialPanes());
  let worktreeModalOpen = $state(false);
  let activePaneId = $state<number | null>(null);

  const pendingStartTimeouts = new Map<number, ReturnType<typeof setTimeout>>();
  const visiblePanes = $derived(panes.slice(0, paneCount));
  const activePaneProject = $derived.by(() => {
    if (activePaneId == null) return "";
    return panes.find((pane) => pane.id === activePaneId)?.project ?? "";
  });

  function createInitialPanes(): ComposerPane[] {
    const list: ComposerPane[] = [];
    for (let index = 0; index < MAX_PANES; index += 1) {
      list.push({
        id: index + 1,
        task: "",
        project: "",
        mode: "code",
        selectedModel: "",
        isCreating: false,
        pendingStartToken: null,
        submitError: null,
      });
    }
    return list;
  }

  function updatePane(paneId: number, patch: Partial<ComposerPane>) {
    panes = panes.map((pane) => (pane.id === paneId ? { ...pane, ...patch } : pane));
  }

  function getPane(paneId: number): ComposerPane | null {
    return panes.find((pane) => pane.id === paneId) ?? null;
  }

  function canSubmit(pane: ComposerPane): boolean {
    return (
      isConnected &&
      pane.task.trim().length > 0 &&
      pane.project.trim().length > 0 &&
      !pane.isCreating
    );
  }

  function modelLabelFor(pane: ComposerPane): string {
    return (
      models.options.find((option) => option.value === pane.selectedModel)?.label ||
      pane.selectedModel ||
      "Select model"
    );
  }

  function worktreeLabelFor(path: string): string {
    if (!path.trim()) return "Select project";

    const selected = worktrees.worktrees.find((worktree) => worktree.path === path);
    const repo = worktrees.repoRoot
      ? worktrees.repoRoot.split("/").filter(Boolean).pop()
      : null;

    if (repo && selected?.branch) return `${repo} / ${selected.branch}`;
    if (repo) return repo;
    return path.split(/[\\/]/).filter(Boolean).pop() || path;
  }

  function clearPendingStart(paneId: number, token: number) {
    const pane = getPane(paneId);
    if (!pane || pane.pendingStartToken !== token) return;

    const timeout = pendingStartTimeouts.get(paneId);
    if (timeout) {
      clearTimeout(timeout);
      pendingStartTimeouts.delete(paneId);
    }

    updatePane(paneId, { isCreating: false, pendingStartToken: null });
  }

  function handleTaskChange(paneId: number, value: string) {
    updatePane(paneId, { task: value });
  }

  function handleSelectModel(paneId: number, value: string) {
    updatePane(paneId, { selectedModel: value });
  }

  function handleToggleMode(paneId: number) {
    const pane = getPane(paneId);
    if (!pane) return;
    updatePane(paneId, { mode: pane.mode === "plan" ? "code" : "plan" });
  }

  function handleOpenWorktrees(paneId: number) {
    activePaneId = paneId;
    worktreeModalOpen = true;
  }

  async function handleProjectConfirm(value: string) {
    if (activePaneId == null) return;
    updatePane(activePaneId, { project: value });
    worktreeModalOpen = false;
    worktrees.select(value);
    if (!worktrees.repoRoot) {
      await worktrees.inspect(value);
    }
  }

  async function handleSubmit(paneId: number) {
    const pane = getPane(paneId);
    if (!pane || !canSubmit(pane) || pane.pendingStartToken !== null) return;

    const token = Date.now() + Math.floor(Math.random() * 1000);
    updatePane(paneId, { isCreating: true, pendingStartToken: token, submitError: null });

    const timeout = setTimeout(() => clearPendingStart(paneId, token), 30000);
    pendingStartTimeouts.set(paneId, timeout);

    try {
      const effectiveModel = pane.selectedModel.trim() || models.defaultModel?.value?.trim() || "";
      const collaborationMode = effectiveModel
        ? threads.resolveCollaborationMode(pane.mode, effectiveModel, "medium")
        : undefined;

      threads.start(pane.project.trim(), pane.task.trim(), {
        suppressNavigation: true,
        ...(collaborationMode ? { collaborationMode } : {}),
        onThreadStarted: () => {
          updatePane(paneId, { task: "" });
          clearPendingStart(paneId, token);
        },
        onThreadStartFailed: (error) => {
          updatePane(paneId, { submitError: error.message || "Failed to create task" });
          clearPendingStart(paneId, token);
        },
      });
    } catch (err) {
      console.error("Failed to create task:", err);
      updatePane(paneId, {
        submitError: err instanceof Error ? err.message : "Failed to create task",
      });
      clearPendingStart(paneId, token);
    }
  }

  $effect(() => {
    const defaultModel = models.defaultModel?.value;
    if (!defaultModel) return;

    let changed = false;
    const next = panes.map((pane) => {
      if (pane.selectedModel) return pane;
      changed = true;
      return { ...pane, selectedModel: defaultModel };
    });

    if (changed) {
      panes = next;
    }
  });

  $effect(() => {
    if (socket.status === "connected") {
      threads.fetch();
      models.fetch();
      threads.fetchCollaborationPresets();
    }
  });
</script>

<svelte:head>
  <title>Zane</title>
</svelte:head>

<div class="home stack">
  <AppHeader status={socket.status}>
    {#snippet actions()}
      <a href="/settings">Settings</a>
      <button type="button" onclick={() => theme.cycle()} title="Theme: {theme.current}">
        {themeIcons[theme.current]}
      </button>
    {/snippet}
  </AppHeader>

  {#if socket.error}
    <div class="error row">
      <span class="error-icon">✗</span>
      <span class="error-text">{socket.error}</span>
    </div>
  {/if}

  <main class="hero">
    <div class="hero-content">
      <section class="pane-toolbar split">
        <div class="pane-count row">
          <span>Input windows</span>
          {#each PANE_COUNT_OPTIONS as count}
            <button
              type="button"
              class="count-btn"
              class:active={paneCount === count}
              onclick={() => {
                paneCount = count;
              }}
            >
              {count}
            </button>
          {/each}
        </div>
        <span class="pane-hint">Each window has its own project, mode and model.</span>
      </section>

      <section class="pane-grid">
        {#each visiblePanes as pane (pane.id)}
          <div class="pane stack">
            <div class="pane-title split">
              <span>Window {pane.id}</span>
              {#if pane.isCreating}
                <span class="pane-status">Starting...</span>
              {/if}
            </div>

            {#if pane.submitError}
              <div class="error pane-error row">
                <span class="error-icon">!</span>
                <span class="error-text">{pane.submitError}</span>
              </div>
            {/if}

            <HomeTaskComposer
              task={pane.task}
              mode={pane.mode}
              isCreating={pane.isCreating}
              canSubmit={canSubmit(pane)}
              worktreeDisplay={worktreeLabelFor(pane.project)}
              currentModelLabel={modelLabelFor(pane)}
              modelsStatus={models.status}
              modelOptions={models.options}
              selectedModel={pane.selectedModel}
              on:taskChange={(e) => handleTaskChange(pane.id, e.detail.value)}
              on:toggleMode={() => handleToggleMode(pane.id)}
              on:openWorktrees={() => handleOpenWorktrees(pane.id)}
              on:selectModel={(e) => handleSelectModel(pane.id, e.detail.value)}
              on:submit={() => handleSubmit(pane.id)}
            />
          </div>
        {/each}
      </section>

      <RecentSessionsList
        loading={threads.loading}
        {recentThreads}
        {hasMoreThreads}
        on:refresh={() => threads.fetch()}
      />
    </div>
  </main>
</div>

<WorktreeModal
  open={worktreeModalOpen}
  project={activePaneProject}
  on:close={() => {
    worktreeModalOpen = false;
    activePaneId = null;
  }}
  on:confirm={(e) => handleProjectConfirm(e.detail.project)}
/>

<style>
  .home {
    min-height: 100vh;
    background: var(--cli-bg);
    color: var(--cli-text);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    --stack-gap: 0;
  }

  .hero {
    display: flex;
    align-items: flex-start;
    justify-content: center;
    min-height: calc(100vh - 3rem);
    padding: var(--space-md);
  }

  .hero-content {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-md);
    width: 100%;
    max-width: min(1600px, calc(100vw - var(--space-md) * 2));
  }

  .pane-toolbar {
    --split-gap: var(--space-md);
    align-items: center;
    padding: var(--space-sm) var(--space-md);
    border: 2px solid var(--cli-border);
    border-radius: var(--radius-md);
    background: var(--cli-bg-elevated);
    box-shadow: var(--shadow-sm);
  }

  .pane-count {
    --row-gap: var(--space-xs);
    align-items: center;
    color: var(--cli-text-dim);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 700;
  }

  .count-btn {
    border: 2px solid var(--cli-border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--cli-text-muted);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: 700;
    padding: 0.15rem 0.45rem;
    box-shadow: var(--shadow-sm);
    cursor: pointer;
  }

  .count-btn.active {
    background: color-mix(in srgb, var(--cli-prefix-agent) 20%, transparent);
    color: var(--cli-prefix-agent);
    border-color: color-mix(in srgb, var(--cli-prefix-agent) 45%, var(--cli-border));
  }

  .pane-hint {
    color: var(--cli-text-muted);
    font-size: var(--text-xs);
    font-weight: 600;
  }

  .pane-grid {
    display: grid;
    gap: var(--space-md);
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  }

  .pane {
    --stack-gap: var(--space-sm);
    padding: var(--space-sm);
    border: 2px solid var(--cli-border);
    border-radius: var(--radius-md);
    background: var(--cli-bg-elevated);
    box-shadow: var(--shadow-sm);
  }

  .pane-title {
    --split-gap: var(--space-sm);
    padding: 0 var(--space-xs);
    color: var(--cli-text-dim);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 700;
  }

  .pane-status {
    color: var(--cli-prefix-agent);
  }

  .error {
    --row-gap: var(--space-sm);
    padding: var(--space-sm) var(--space-md);
    background: var(--cli-error-bg);
    border-bottom: 2px solid var(--cli-border);
    color: var(--cli-error);
  }

  .pane-error {
    border-bottom: 0;
    border-radius: var(--radius-sm);
    padding: var(--space-xs) var(--space-sm);
  }

  .error-icon {
    font-weight: 600;
  }

  @media (max-width: 900px) {
    .pane-toolbar {
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-sm);
    }

    .pane-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
