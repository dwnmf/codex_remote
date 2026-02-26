<script lang="ts">
  import { socket } from "../lib/socket.svelte";
  import { threads } from "../lib/threads.svelte";
  import { messages } from "../lib/messages.svelte";
  import { theme } from "../lib/theme.svelte";
  import { models } from "../lib/models.svelte";
  import { anchors } from "../lib/anchors.svelte";
  import { auth } from "../lib/auth.svelte";
  import { worktrees } from "../lib/worktrees.svelte";
  import {
    parseUlwCommand,
    pickUlwTaskFromMessages,
    ulwLoopRunner,
    ulwRuntime,
  } from "../lib/ulw";
  import AppHeader from "../lib/components/AppHeader.svelte";
  import HomeTaskComposer from "../lib/components/HomeTaskComposer.svelte";
  import WorktreeModal from "../lib/components/WorktreeModal.svelte";
  import RecentSessionsList from "../lib/components/RecentSessionsList.svelte";
  import MessageBlock from "../lib/components/MessageBlock.svelte";
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
    threadId: string | null;
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
        threadId: null,
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
    const hasThread = Boolean(pane.threadId);
    const running = pane.threadId
      ? (messages.getThreadTurnStatus(pane.threadId) ?? "").toLowerCase() === "inprogress"
      : false;
    return (
      isConnected &&
      pane.task.trim().length > 0 &&
      (hasThread || pane.project.trim().length > 0) &&
      !pane.isCreating &&
      !running
    );
  }

  function paneIsRunning(pane: ComposerPane): boolean {
    if (!pane.threadId) return false;
    return (messages.getThreadTurnStatus(pane.threadId) ?? "").toLowerCase() === "inprogress";
  }

  function paneMessages(pane: ComposerPane) {
    if (!pane.threadId) return [];
    return messages.getThreadMessages(pane.threadId).slice(-40);
  }

  function sendTurnFromPane(paneId: number, targetThreadId: string, inputText: string): string | null {
    const pane = getPane(paneId);
    if (!pane) return "Pane not found";

    const text = inputText.trim();
    if (!text) return "Input is empty";

    const selectedAnchorId = !auth.isLocalMode ? anchors.selectedId : null;
    if (!auth.isLocalMode) {
      if (!selectedAnchorId) return "Select a device in Settings before sending messages.";
      if (!anchors.selected) return "Selected device is offline. Choose another device in Settings.";
    }

    const params: Record<string, unknown> = {
      threadId: targetThreadId,
      input: [{ type: "text", text }],
      ...(selectedAnchorId ? { anchorId: selectedAnchorId } : {}),
    };

    const effectiveModel = pane.selectedModel.trim() || models.defaultModel?.value?.trim() || "";
    if (effectiveModel) {
      params.model = effectiveModel;
      params.collaborationMode = threads.resolveCollaborationMode(pane.mode, effectiveModel, "medium");
    }
    params.effort = "medium";

    const result = socket.send({
      method: "turn/start",
      id: Date.now(),
      params,
    });

    return result.success ? null : result.error ?? "Failed to send message";
  }

  function handleStopPane(paneId: number) {
    const pane = getPane(paneId);
    if (!pane?.threadId) return;
    ulwLoopRunner.stop(pane.threadId, "user_interrupt");
    const result = messages.interrupt(pane.threadId);
    if (!result.success) {
      updatePane(paneId, { submitError: result.error ?? "Failed to stop turn" });
    }
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
    const pane = getPane(activePaneId);
    if (pane?.threadId && pane.project.trim() !== value.trim()) {
      ulwLoopRunner.stop(pane.threadId, "project_changed");
      updatePane(activePaneId, { project: value, threadId: null, submitError: null });
    } else {
      updatePane(activePaneId, { project: value });
    }
    worktreeModalOpen = false;
    worktrees.select(value);
    if (!worktrees.repoRoot) {
      await worktrees.inspect(value);
    }
  }

  async function handleSubmit(paneId: number) {
    const pane = getPane(paneId);
    if (!pane || !canSubmit(pane)) return;

    const rawInput = pane.task.trim();
    const ulwCommand = parseUlwCommand(rawInput);
    const loopDeps = {
      sendTurn: (threadId: string, inputText: string) =>
        sendTurnFromPane(paneId, threadId, inputText) === null,
      onTurnComplete: messages.onTurnComplete.bind(messages),
    };

    if (pane.threadId) {
      if (ulwCommand?.kind === "stop") {
        handleStopPane(paneId);
        updatePane(paneId, { task: "", submitError: null });
        return;
      }

      if (ulwCommand?.kind === "config") {
        if (
          typeof ulwCommand.maxIterations !== "number" &&
          !ulwCommand.completionPromise
        ) {
          updatePane(paneId, { submitError: "Usage: /u config max=30 promise=DONE" });
          return;
        }
        ulwRuntime.configure(pane.threadId, {
          maxIterations: ulwCommand.maxIterations,
          completionPromise: ulwCommand.completionPromise,
        });
        updatePane(paneId, { task: "", submitError: null });
        return;
      }

      if (ulwCommand?.kind === "start") {
        const task =
          ulwCommand.task ?? pickUlwTaskFromMessages(messages.getThreadMessages(pane.threadId));
        if (!task) {
          updatePane(paneId, { submitError: "Add task after /u for this window." });
          return;
        }
        ulwLoopRunner.start(
          pane.threadId,
          {
            task,
            maxIterations: ulwCommand.maxIterations,
            completionPromise: ulwCommand.completionPromise,
          },
          loopDeps,
        );
        updatePane(paneId, { task: "", submitError: null });
        return;
      }

      if (ulwRuntime.isActive(pane.threadId)) {
        ulwLoopRunner.stop(pane.threadId, "manual_user_input");
      }
      const error = sendTurnFromPane(paneId, pane.threadId, rawInput);
      updatePane(paneId, {
        task: error ? pane.task : "",
        submitError: error,
      });
      return;
    }

    if (pane.pendingStartToken !== null) return;
    if (ulwCommand?.kind === "stop") {
      updatePane(paneId, { submitError: "Use /u stop inside an active window terminal." });
      return;
    }
    if (ulwCommand?.kind === "config") {
      updatePane(paneId, { submitError: "Start a window session first, then run /u config." });
      return;
    }

    const token = Date.now() + Math.floor(Math.random() * 1000);
    updatePane(paneId, { isCreating: true, pendingStartToken: token, submitError: null });

    const timeout = setTimeout(() => clearPendingStart(paneId, token), 30000);
    pendingStartTimeouts.set(paneId, timeout);

    try {
      const effectiveModel = pane.selectedModel.trim() || models.defaultModel?.value?.trim() || "";
      const collaborationMode = effectiveModel
        ? threads.resolveCollaborationMode(pane.mode, effectiveModel, "medium")
        : undefined;

      const startInput = ulwCommand?.kind === "start" ? undefined : rawInput;
      threads.start(pane.project.trim(), startInput, {
        suppressNavigation: true,
        ...(collaborationMode ? { collaborationMode } : {}),
        onThreadStarted: (threadId) => {
          updatePane(paneId, { task: "", threadId, submitError: null });
          clearPendingStart(paneId, token);

          if (ulwCommand?.kind === "start") {
            if (!ulwCommand.task) {
              updatePane(paneId, { submitError: "Add task after /u when launching from Home." });
              return;
            }
            ulwLoopRunner.start(
              threadId,
              {
                task: ulwCommand.task,
                maxIterations: ulwCommand.maxIterations,
                completionPromise: ulwCommand.completionPromise,
              },
              loopDeps,
            );
          }
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
      <section class="workspace stack">
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

              {#if pane.threadId}
                <section class="pane-terminal stack">
                  <div class="pane-terminal-header split">
                    <span>Terminal • {pane.threadId.slice(0, 8)}</span>
                    <div class="pane-terminal-actions row">
                      {#if paneIsRunning(pane)}
                        <button type="button" class="terminal-stop" onclick={() => handleStopPane(pane.id)}>
                          Stop
                        </button>
                      {/if}
                      <a href={"/thread/" + pane.threadId}>Open</a>
                    </div>
                  </div>
                  <div class="pane-terminal-body">
                    {#if paneMessages(pane).length === 0}
                      <div class="pane-terminal-empty">Waiting for output...</div>
                    {:else}
                      {#each paneMessages(pane) as message (message.id)}
                        <MessageBlock {message} />
                      {/each}
                    {/if}
                  </div>
                </section>
              {/if}
            </div>
          {/each}
        </section>

        <RecentSessionsList
          loading={threads.loading}
          {recentThreads}
          {hasMoreThreads}
          on:refresh={() => threads.fetch()}
        />
      </section>
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
    align-items: stretch;
    justify-content: center;
    min-height: calc(100vh - 3rem);
    padding: var(--space-md) var(--space-lg);
  }

  .hero-content {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-sm);
    width: 100%;
    max-width: min(1480px, calc(100vw - var(--space-lg) * 2));
  }

  .workspace {
    --stack-gap: var(--space-md);
    padding: 0;
    background: transparent;
    box-shadow: none;
  }

  .pane-toolbar {
    --split-gap: var(--space-md);
    align-items: center;
    padding: 0.35rem 0;
    border: 1px solid var(--cli-border);
    border-left: 0;
    border-right: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
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
    border: 1px solid var(--cli-border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--cli-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 600;
    padding: 0.25rem 0.45rem;
    box-shadow: none;
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
    grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  }

  .pane {
    --stack-gap: var(--space-sm);
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }

  .pane-title {
    --split-gap: var(--space-sm);
    padding: 0;
    color: var(--cli-text-dim);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
  }

  .pane-status {
    color: var(--cli-prefix-agent);
  }

  .pane-terminal {
    --stack-gap: 0;
    border: 1px solid var(--cli-border);
    border-radius: var(--radius-md);
    overflow: hidden;
    background: var(--cli-bg);
  }

  .pane-terminal-header {
    --split-gap: var(--space-sm);
    padding: 0.42rem 0.62rem;
    border-bottom: 1px solid var(--cli-border);
    color: var(--cli-text-dim);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: var(--cli-bg-elevated);
  }

  .pane-terminal-actions {
    --row-gap: var(--space-sm);
    align-items: center;
  }

  .pane-terminal-actions a {
    color: var(--cli-prefix-agent);
    text-decoration: none;
    font-weight: 600;
  }

  .terminal-stop {
    border: 1px solid color-mix(in srgb, var(--cli-error) 40%, var(--cli-border));
    background: transparent;
    color: var(--cli-error);
    border-radius: var(--radius-sm);
    padding: 0.16rem 0.4rem;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .pane-terminal-body {
    max-height: 15rem;
    overflow-y: auto;
    padding: var(--space-xs) 0;
  }

  .pane-terminal-empty {
    padding: var(--space-sm) var(--space-md);
    color: var(--cli-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .error {
    --row-gap: var(--space-sm);
    padding: var(--space-sm) var(--space-md);
    background: var(--cli-error-bg);
    border-bottom: 1px solid var(--cli-border);
    color: var(--cli-error);
  }

  .pane-error {
    border-bottom: 0;
    border-radius: var(--radius-md);
    padding: var(--space-xs) var(--space-sm);
  }

  .error-icon {
    font-weight: 600;
  }

  @media (max-width: 900px) {
    .hero {
      padding: var(--space-md);
    }

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
