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
  import { buildBangTerminalPrompt, parseBangTerminalCommand } from "../lib/bang-command";
  import { readTurnImages } from "../lib/input-images";
  import AppHeader from "../lib/components/AppHeader.svelte";
  import HomeTaskComposer from "../lib/components/HomeTaskComposer.svelte";
  import WorktreeModal from "../lib/components/WorktreeModal.svelte";
  import RecentSessionsList from "../lib/components/RecentSessionsList.svelte";
  import MessageBlock from "../lib/components/MessageBlock.svelte";
  import ApprovalPrompt from "../lib/components/ApprovalPrompt.svelte";
  import UserInputPrompt from "../lib/components/UserInputPrompt.svelte";
  import PlanCard from "../lib/components/PlanCard.svelte";
  import type { ModeKind, TurnImageInput } from "../lib/types";

  const themeIcons = { system: "◐", light: "○", dark: "●" } as const;
  const RECENT_LIMIT = 5;
  const PANE_COUNT_OPTIONS = [1, 2, 4, 8] as const;
  const MAX_PANES = 8;

  type PaneCount = (typeof PANE_COUNT_OPTIONS)[number];

  interface ComposerPane {
    id: number;
    task: string;
    taskAttachments: TurnImageInput[];
    terminalInput: string;
    terminalAttachments: TurnImageInput[];
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

  let paneCount = $state<PaneCount>(1);
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
        taskAttachments: [],
        terminalInput: "",
        terminalAttachments: [],
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
      (pane.task.trim().length > 0 || pane.taskAttachments.length > 0) &&
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

  function resolvePaneCollaborationMode(pane: ComposerPane) {
    const effectiveModel = pane.selectedModel.trim() || models.defaultModel?.value?.trim() || "";
    if (!effectiveModel) return undefined;
    return threads.resolveCollaborationMode(pane.mode, effectiveModel, "medium");
  }

  function lastPlanIdForPane(pane: ComposerPane): string | null {
    const paneMsgs = paneMessages(pane);
    for (let i = paneMsgs.length - 1; i >= 0; i -= 1) {
      if (paneMsgs[i].kind === "plan") return paneMsgs[i].id;
    }
    return null;
  }

  function buildTurnInputItems(inputText: string, imageInputs: TurnImageInput[]): Array<Record<string, unknown>> {
    const items: Array<Record<string, unknown>> = [];
    const normalizedInput = inputText.trim();
    if (normalizedInput) {
      items.push({ type: "text", text: normalizedInput });
    }
    for (const image of imageInputs) {
      if (!image.dataUrl) continue;
      items.push({ type: "input_image", image_url: image.dataUrl, detail: "auto" });
    }
    return items;
  }

  function sendTurnFromPane(
    paneId: number,
    targetThreadId: string,
    inputText: string,
    imageInputs: TurnImageInput[] = [],
  ): string | null {
    const pane = getPane(paneId);
    if (!pane) return "Pane not found";

    const input = buildTurnInputItems(inputText, imageInputs);
    if (input.length === 0) return "Input is empty";

    const selectedAnchorId = !auth.isLocalMode ? anchors.selectedId : null;
    if (!auth.isLocalMode) {
      if (!selectedAnchorId) return "Select a device in Settings before sending messages.";
      if (!anchors.selected) return "Selected device is offline. Choose another device in Settings.";
    }

    const params: Record<string, unknown> = {
      threadId: targetThreadId,
      input,
      ...(selectedAnchorId ? { anchorId: selectedAnchorId } : {}),
    };

    const effectiveModel = pane.selectedModel.trim() || models.defaultModel?.value?.trim() || "";
    if (effectiveModel) {
      params.model = effectiveModel;
      params.collaborationMode = resolvePaneCollaborationMode(pane);
    }
    params.effort = "medium";

    const result = socket.send({
      method: "turn/start",
      id: Date.now(),
      params,
    });

    return result.success ? null : result.error ?? "Failed to send message";
  }

  function handlePanePlanApprove(paneId: number, messageId: string) {
    const pane = getPane(paneId);
    if (!pane?.threadId) return;
    messages.approvePlan(messageId, pane.threadId);
    updatePane(paneId, { mode: "code" });
    const error = sendTurnFromPane(paneId, pane.threadId, "Approved. Proceed with implementation.");
    if (error) {
      updatePane(paneId, { submitError: error });
    }
  }

  function submitToExistingThread(paneId: number, rawInput: string, imageInputs: TurnImageInput[] = []): string | null {
    const pane = getPane(paneId);
    if (!pane?.threadId) return "Session is not started for this window.";

    const normalizedInput = rawInput.trim();
    if (!normalizedInput && imageInputs.length === 0) return "Input is empty";
    if (imageInputs.length > 0 && (normalizedInput.startsWith("/u") || normalizedInput.startsWith("!"))) {
      return "Images can be sent with normal messages only.";
    }

    const ulwCommand = parseUlwCommand(normalizedInput);
    const loopDeps = {
      sendTurn: (threadId: string, inputText: string) =>
        sendTurnFromPane(paneId, threadId, inputText) === null,
      onTurnComplete: messages.onTurnComplete.bind(messages),
    };

    if (ulwCommand?.kind === "stop") {
      handleStopPane(paneId);
      return null;
    }

    if (ulwCommand?.kind === "config") {
      if (
        typeof ulwCommand.maxIterations !== "number" &&
        !ulwCommand.completionPromise
      ) {
        return "Usage: /u config max=30 promise=DONE";
      }
      ulwRuntime.configure(pane.threadId, {
        maxIterations: ulwCommand.maxIterations,
        completionPromise: ulwCommand.completionPromise,
      });
      return null;
    }

    if (ulwCommand?.kind === "start") {
      const task =
        ulwCommand.task ?? pickUlwTaskFromMessages(messages.getThreadMessages(pane.threadId));
      if (!task) return "Add task after /u for this window.";
      ulwLoopRunner.start(
        pane.threadId,
        {
          task,
          maxIterations: ulwCommand.maxIterations,
          completionPromise: ulwCommand.completionPromise,
        },
        loopDeps,
      );
      return null;
    }

    const bangCommand = parseBangTerminalCommand(normalizedInput);
    if (bangCommand) {
      if (!bangCommand.command) {
        return "Usage: !<command> or !pwsh|cmd|bash|sh|zsh|fish <command>";
      }
      if (ulwRuntime.isActive(pane.threadId)) {
        ulwLoopRunner.stop(pane.threadId, "manual_user_input");
      }
      return sendTurnFromPane(paneId, pane.threadId, buildBangTerminalPrompt(bangCommand));
    }

    if (ulwRuntime.isActive(pane.threadId)) {
      ulwLoopRunner.stop(pane.threadId, "manual_user_input");
    }
    return sendTurnFromPane(paneId, pane.threadId, normalizedInput, imageInputs);
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

  function handleTaskImagesAdded(paneId: number, images: TurnImageInput[]) {
    const pane = getPane(paneId);
    if (!pane || images.length === 0) return;
    updatePane(paneId, { taskAttachments: [...pane.taskAttachments, ...images] });
  }

  function handleTaskImageRemoved(paneId: number, imageId: string) {
    const pane = getPane(paneId);
    if (!pane) return;
    updatePane(paneId, { taskAttachments: pane.taskAttachments.filter((image) => image.id !== imageId) });
  }

  function handleTaskImagesCleared(paneId: number) {
    updatePane(paneId, { taskAttachments: [] });
  }

  function handleTerminalInputChange(paneId: number, value: string) {
    updatePane(paneId, { terminalInput: value });
  }

  async function handleTerminalImagesSelected(paneId: number, files: FileList | null) {
    const pane = getPane(paneId);
    if (!pane || !files || files.length === 0) return;
    const result = await readTurnImages(files, pane.terminalAttachments.length);
    if (result.images.length > 0) {
      updatePane(paneId, { terminalAttachments: [...pane.terminalAttachments, ...result.images], submitError: null });
    }
    if (result.errors.length > 0) {
      updatePane(paneId, { submitError: result.errors.join(" ") });
    }
  }

  function handleTerminalImageRemoved(paneId: number, imageId: string) {
    const pane = getPane(paneId);
    if (!pane) return;
    updatePane(paneId, {
      terminalAttachments: pane.terminalAttachments.filter((image) => image.id !== imageId),
    });
  }

  function clearTerminalImages(paneId: number) {
    updatePane(paneId, { terminalAttachments: [] });
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

  function canSendTerminalInput(pane: ComposerPane): boolean {
    if (!pane.threadId) return false;
    if (!isConnected) return false;
    if (pane.terminalInput.trim().length === 0 && pane.terminalAttachments.length === 0) return false;
    return !paneIsRunning(pane);
  }

  function handleTerminalInputSubmit(paneId: number) {
    const pane = getPane(paneId);
    if (!pane?.threadId || !canSendTerminalInput(pane)) return;
    const error = submitToExistingThread(paneId, pane.terminalInput, pane.terminalAttachments);
    updatePane(paneId, {
      terminalInput: error ? pane.terminalInput : "",
      terminalAttachments: error ? pane.terminalAttachments : [],
      submitError: error,
    });
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

    if (pane.threadId) {
      const error = submitToExistingThread(paneId, rawInput, pane.taskAttachments);
      updatePane(paneId, {
        task: error ? pane.task : "",
        taskAttachments: error ? pane.taskAttachments : [],
        submitError: error,
      });
      return;
    }

    if (pane.pendingStartToken !== null) return;
    const ulwCommand = parseUlwCommand(rawInput);
    const bangCommand = ulwCommand ? null : parseBangTerminalCommand(rawInput);
    if (ulwCommand?.kind === "stop") {
      updatePane(paneId, { submitError: "Use /u stop inside an active window terminal." });
      return;
    }
    if (ulwCommand?.kind === "config") {
      updatePane(paneId, { submitError: "Start a window session first, then run /u config." });
      return;
    }
    if (bangCommand && !bangCommand.command) {
      updatePane(paneId, { submitError: "Usage: !<command> or !pwsh|cmd|bash|sh|zsh|fish <command>" });
      return;
    }
    if (pane.taskAttachments.length > 0 && (ulwCommand || bangCommand)) {
      updatePane(paneId, { submitError: "Images can be sent with normal messages only." });
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

      const hasStartImages = pane.taskAttachments.length > 0;
      const startInput = hasStartImages || ulwCommand?.kind === "start"
        ? undefined
        : bangCommand
          ? buildBangTerminalPrompt(bangCommand)
          : rawInput;
      threads.start(pane.project.trim(), startInput, {
        suppressNavigation: true,
        ...(collaborationMode ? { collaborationMode } : {}),
        onThreadStarted: (threadId) => {
          updatePane(paneId, { threadId, submitError: null });
          clearPendingStart(paneId, token);

          if (ulwCommand?.kind === "start") {
            updatePane(paneId, { task: "", taskAttachments: [] });
            if (!ulwCommand.task) {
              updatePane(paneId, { submitError: "Add task after /u when launching from Home." });
              return;
            }
            const loopDeps = {
              sendTurn: (threadId: string, inputText: string) =>
                sendTurnFromPane(paneId, threadId, inputText) === null,
              onTurnComplete: messages.onTurnComplete.bind(messages),
            };
            ulwLoopRunner.start(
              threadId,
              {
                task: ulwCommand.task,
                maxIterations: ulwCommand.maxIterations,
                completionPromise: ulwCommand.completionPromise,
              },
              loopDeps,
            );
          } else if (hasStartImages) {
            const sendError = sendTurnFromPane(paneId, threadId, rawInput, pane.taskAttachments);
            if (sendError) {
              updatePane(paneId, { task: rawInput, taskAttachments: pane.taskAttachments, submitError: sendError });
            } else {
              updatePane(paneId, { task: "", taskAttachments: [] });
            }
          } else {
            updatePane(paneId, { task: "", taskAttachments: [] });
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
  <title>Codex Remote</title>
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
        <section class="workspace-masthead">
          <span class="workspace-kicker">Homepage</span>
          <h1 class="workspace-title">
            <span class="workspace-title-main">CODEX</span>
            <span class="workspace-title-sub"><span class="workspace-title-editorial">(remote)</span> control center</span>
          </h1>
          <p class="workspace-summary">
            Run parallel coding windows, switch projects, and keep approvals in one place.
          </p>
        </section>

        <section class="pane-toolbar split">
          <div class="pane-count row">
            <span class="count-label">Input windows</span>
            <div class="count-group row">
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
                taskAttachments={pane.taskAttachments}
                on:taskChange={(e) => handleTaskChange(pane.id, e.detail.value)}
                on:toggleMode={() => handleToggleMode(pane.id)}
                on:openWorktrees={() => handleOpenWorktrees(pane.id)}
                on:selectModel={(e) => handleSelectModel(pane.id, e.detail.value)}
                on:taskImagesAdded={(e) => handleTaskImagesAdded(pane.id, e.detail.images)}
                on:taskImageRemoved={(e) => handleTaskImageRemoved(pane.id, e.detail.id)}
                on:taskImagesCleared={() => handleTaskImagesCleared(pane.id)}
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
                        {#if message.role === "approval" && message.approval}
                          <ApprovalPrompt
                            approval={message.approval}
                            onApprove={(forSession) =>
                              messages.approve(
                                message.approval!.id,
                                forSession,
                                resolvePaneCollaborationMode(pane),
                                pane.threadId ?? undefined,
                              )}
                            onDecline={() =>
                              messages.decline(
                                message.approval!.id,
                                resolvePaneCollaborationMode(pane),
                                pane.threadId ?? undefined,
                              )}
                            onCancel={() => messages.cancel(message.approval!.id, pane.threadId ?? undefined)}
                          />
                        {:else if message.kind === "user-input-request" && message.userInputRequest}
                          <UserInputPrompt
                            request={message.userInputRequest}
                            onSubmit={(answers) =>
                              messages.respondToUserInput(
                                message.id,
                                answers,
                                resolvePaneCollaborationMode(pane),
                                pane.threadId ?? undefined,
                              )}
                          />
                        {:else if message.kind === "plan"}
                          <PlanCard
                            {message}
                            disabled={(messages.getThreadTurnStatus(pane.threadId) ?? "").toLowerCase() === "inprogress" || !socket.isHealthy}
                            latest={message.id === lastPlanIdForPane(pane)}
                            onApprove={() => handlePanePlanApprove(pane.id, message.id)}
                          />
                        {:else}
                          <MessageBlock {message} />
                        {/if}
                      {/each}
                    {/if}
                  </div>
                  <form
                    class="pane-terminal-input row"
                    onsubmit={(e) => {
                      e.preventDefault();
                      handleTerminalInputSubmit(pane.id);
                    }}
                  >
                    <input
                      id={"terminal-images-" + pane.id}
                      class="terminal-image-picker"
                      type="file"
                      accept="image/*"
                      multiple
                      onchange={async (e) => {
                        const target = e.currentTarget as HTMLInputElement;
                        await handleTerminalImagesSelected(pane.id, target.files);
                        target.value = "";
                      }}
                    />
                    <label class="terminal-attach" for={"terminal-images-" + pane.id} title="Attach images">
                      Img
                    </label>
                    <input
                      type="text"
                      placeholder="Type message, attach image, !command, or /u command for this window"
                      value={pane.terminalInput}
                      oninput={(e) => handleTerminalInputChange(pane.id, (e.currentTarget as HTMLInputElement).value)}
                      disabled={!pane.threadId || !isConnected || paneIsRunning(pane)}
                    />
                    <button type="submit" disabled={!canSendTerminalInput(pane)}>
                      Send
                    </button>
                  </form>
                  {#if pane.terminalAttachments.length > 0}
                    <div class="terminal-attachments row">
                      {#each pane.terminalAttachments as image (image.id)}
                        <div class="terminal-attachment row">
                          <img src={image.dataUrl} alt={image.name} />
                          <span>{image.name}</span>
                          <button type="button" onclick={() => handleTerminalImageRemoved(pane.id, image.id)}>×</button>
                        </div>
                      {/each}
                      <button type="button" class="terminal-attachment-clear" onclick={() => clearTerminalImages(pane.id)}>
                        Clear
                      </button>
                    </div>
                  {/if}
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

  .workspace-masthead {
    display: grid;
    gap: 0.24rem;
    padding: 0.12rem 0 0.24rem;
  }

  .workspace-kicker {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.11em;
    color: var(--cli-text-muted);
    line-height: 1.2;
  }

  .workspace-title {
    margin: 0;
    display: grid;
    gap: 0.16rem;
  }

  .workspace-title-main {
    font-family: var(--font-display);
    font-size: clamp(3.2rem, 12vw, 8.6rem);
    text-transform: uppercase;
    line-height: 0.82;
    letter-spacing: -0.012em;
    color: var(--cli-text);
  }

  .workspace-title-sub {
    font-family: var(--font-sans);
    font-size: clamp(1.2rem, 3vw, 2.2rem);
    line-height: 1;
    letter-spacing: -0.015em;
    color: var(--cli-text-dim);
  }

  .workspace-title-editorial {
    font-family: var(--font-editorial);
    font-style: italic;
    font-weight: 400;
    color: var(--cli-text);
  }

  .workspace-summary {
    margin: 0;
    max-width: 58ch;
    color: var(--cli-text-dim);
    font-family: var(--font-editorial);
    font-size: 1.02rem;
    line-height: 1.45;
    letter-spacing: 0.008em;
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
    letter-spacing: 0.06em;
    font-weight: 600;
    font-family: var(--font-mono);
  }

  .count-label {
    color: var(--cli-text-muted);
  }

  .count-group {
    --row-gap: 0;
    border: 1px solid color-mix(in srgb, var(--cli-border) 52%, transparent);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .count-btn {
    border: 0;
    border-right: 1px solid color-mix(in srgb, var(--cli-border) 52%, transparent);
    border-radius: 0;
    background: transparent;
    color: var(--cli-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 600;
    min-width: 2rem;
    padding: 0.28rem 0.52rem;
    box-shadow: none;
    cursor: pointer;
  }

  .count-group .count-btn:last-child {
    border-right: 0;
  }

  .count-btn.active {
    background: color-mix(in srgb, var(--cli-text) 11%, transparent);
    color: var(--cli-text);
  }

  .pane-hint {
    color: var(--cli-text-muted);
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    font-weight: 500;
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

  .pane-terminal-input {
    --row-gap: var(--space-xs);
    align-items: center;
    gap: var(--space-xs);
    padding: var(--space-xs);
    border-top: 1px solid var(--cli-border);
    background: var(--cli-bg-elevated);
  }

  .terminal-image-picker {
    display: none;
  }

  .terminal-attach {
    border: 1px solid var(--cli-border);
    border-radius: var(--radius-sm);
    padding: 0.28rem 0.42rem;
    background: transparent;
    color: var(--cli-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .pane-terminal-input input[type="text"] {
    flex: 1;
    min-width: 0;
    border: 1px solid var(--cli-border);
    border-radius: var(--radius-sm);
    padding: 0.35rem 0.45rem;
    background: var(--cli-bg);
    color: var(--cli-text);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .pane-terminal-input input[type="text"]:focus {
    outline: none;
    border-color: var(--cli-prefix-agent);
  }

  .pane-terminal-input button {
    border: 1px solid var(--cli-border);
    border-radius: var(--radius-sm);
    padding: 0.28rem 0.52rem;
    background: transparent;
    color: var(--cli-prefix-agent);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .pane-terminal-input button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .pane-terminal-empty {
    padding: var(--space-sm) var(--space-md);
    color: var(--cli-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .terminal-attachments {
    --row-gap: var(--space-xs);
    flex-wrap: wrap;
    gap: var(--space-xs);
    padding: 0 var(--space-xs) var(--space-xs);
    border-top: 1px solid var(--cli-border);
    background: var(--cli-bg-elevated);
  }

  .terminal-attachment {
    --row-gap: var(--space-xs);
    max-width: min(14rem, 100%);
    padding: 0.1rem 0.35rem 0.1rem 0.1rem;
    border: 1px solid var(--cli-border);
    border-radius: 999px;
    background: var(--cli-bg);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--cli-text-muted);
  }

  .terminal-attachment img {
    width: 1rem;
    height: 1rem;
    border-radius: 999px;
    object-fit: cover;
    border: 1px solid var(--cli-border);
  }

  .terminal-attachment span {
    max-width: 8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .terminal-attachment button,
  .terminal-attachment-clear {
    border: none;
    background: transparent;
    color: var(--cli-text-muted);
    cursor: pointer;
    padding: 0;
    font-size: var(--text-xs);
    line-height: 1;
  }

  .terminal-attachment-clear {
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 700;
    margin-left: var(--space-xs);
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
