<script lang="ts">
    import type { ModeKind, ReasoningEffort, SandboxMode, TurnImageInput } from "../lib/types";
    import { route } from "../router";
    import { socket } from "../lib/socket.svelte";
    import { threads } from "../lib/threads.svelte";
    import { messages } from "../lib/messages.svelte";
    import { models } from "../lib/models.svelte";
    import { anchors } from "../lib/anchors.svelte";
    import { auth } from "../lib/auth.svelte";
    import { theme } from "../lib/theme.svelte";
    import {
        parseUlwCommand,
        pickUlwTaskFromMessages,
        ulwLoopRunner,
        ulwRuntime,
    } from "../lib/ulw";
    import { buildBangTerminalPrompt, parseBangTerminalCommand } from "../lib/bang-command";
    import AppHeader from "../lib/components/AppHeader.svelte";
    import MessageBlock from "../lib/components/MessageBlock.svelte";
    import ApprovalPrompt from "../lib/components/ApprovalPrompt.svelte";
    import UserInputPrompt from "../lib/components/UserInputPrompt.svelte";
    import PlanCard from "../lib/components/PlanCard.svelte";
    import WorkingStatus from "../lib/components/WorkingStatus.svelte";
    import Reasoning from "../lib/components/Reasoning.svelte";
    import PromptInput from "../lib/components/PromptInput.svelte";

    const themeIcons = { system: "◐", light: "○", dark: "●" } as const;

    let model = $state("");
    let reasoningEffort = $state<ReasoningEffort>("medium");
    let sandbox = $state<SandboxMode>("workspace-write");
    let mode = $state<ModeKind>("code");
    let modeUserOverride = false;
    let trackedPlanId: string | null = null;
    let container: HTMLDivElement | undefined;
    let turnStartTime = $state<number | undefined>(undefined);

    const threadId = $derived(route.params.id);
    const selectedModelOption = $derived(models.options.find((option) => option.value === model) ?? null);
    const threadShortId = $derived(threadId ? threadId.slice(0, 8) : "--------");
    const threadStatusLabel = $derived.by(() => {
        if (socket.status === "connected") return "Live";
        if (socket.status === "connecting") return "Connecting";
        if (socket.status === "reconnecting") return "Reconnecting";
        return "Offline";
    });


    $effect(() => {
        if (threadId && socket.status === "connected" && threads.currentId !== threadId) {
            threads.open(threadId);
        }
    });

    $effect(() => {
        if (!threadId) return;
        const settings = threads.getSettings(threadId);
        model = settings.model;
        reasoningEffort = settings.reasoningEffort;
        sandbox = settings.sandbox;
        if (!modeUserOverride) {
            mode = settings.mode;
        }
    });

    $effect(() => {
        if (!threadId) return;
        threads.updateSettings(threadId, { model, reasoningEffort, sandbox, mode });
    });

    $effect(() => {
        if (!selectedModelOption?.supportedReasoningEfforts?.length) return;
        if (selectedModelOption.supportedReasoningEfforts.includes(reasoningEffort)) return;

        const nextReasoning =
            selectedModelOption.defaultReasoningEffort &&
            selectedModelOption.supportedReasoningEfforts.includes(selectedModelOption.defaultReasoningEffort)
                ? selectedModelOption.defaultReasoningEffort
                : selectedModelOption.supportedReasoningEfforts[0];

        reasoningEffort = nextReasoning;
    });

    $effect(() => {
        if (messages.current.length && container) {
            container.scrollTop = container.scrollHeight;
        }
    });

    $effect(() => {
        if ((messages.turnStatus ?? "").toLowerCase() === "inprogress" && !turnStartTime) {
            turnStartTime = Date.now();
        } else if ((messages.turnStatus ?? "").toLowerCase() !== "inprogress") {
            turnStartTime = undefined;
        }
    });

    let sendError = $state<string | null>(null);

    function buildTurnInputItems(inputText: string, imageInputs: TurnImageInput[]): Array<Record<string, unknown>> {
        const normalizedInput = inputText.trim();
        const items: Array<Record<string, unknown>> = [];
        if (normalizedInput) {
            items.push({ type: "text", text: normalizedInput });
        }
        for (const image of imageInputs) {
            if (!image.dataUrl) continue;
            items.push({ type: "input_image", image_url: image.dataUrl, detail: "auto" });
        }
        return items;
    }

    function sendTurnText(targetThreadId: string, inputText: string, imageInputs: TurnImageInput[] = []): boolean {
        const inputItems = buildTurnInputItems(inputText, imageInputs);
        if (inputItems.length === 0) return false;

        sendError = null;

        const selectedAnchorId = !auth.isLocalMode ? anchors.selectedId : null;
        if (!auth.isLocalMode) {
            if (!selectedAnchorId) {
                sendError = "Select a device in Settings before sending messages.";
                return false;
            }
            if (!anchors.selected) {
                sendError = "Selected device is offline. Choose another device in Settings.";
                return false;
            }
        }

        const params: Record<string, unknown> = {
            threadId: targetThreadId,
            input: inputItems,
            ...(selectedAnchorId ? { anchorId: selectedAnchorId } : {}),
        };

        if (model.trim()) {
            params.model = model.trim();
        }
        if (reasoningEffort) {
            params.effort = reasoningEffort;
        }
        if (sandbox) {
            const sandboxTypeMap: Record<SandboxMode, string> = {
                "read-only": "readOnly",
                "workspace-write": "workspaceWrite",
                "danger-full-access": "dangerFullAccess",
            };
            params.sandboxPolicy = { type: sandboxTypeMap[sandbox] };
        }

        if (model.trim()) {
            params.collaborationMode = threads.resolveCollaborationMode(
                mode,
                model.trim(),
                reasoningEffort,
            );
        }

        const result = socket.send({
            method: "turn/start",
            id: Date.now(),
            params,
        });

        if (!result.success) {
            sendError = result.error ?? "Failed to send message";
            return false;
        }

        return true;
    }

    function handleSubmit(inputText: string, imageInputs: TurnImageInput[] = []) {
        if (!threadId) return;

        const normalizedInput = inputText.trim();
        if (!normalizedInput && imageInputs.length === 0) return;
        if (imageInputs.length > 0 && (normalizedInput.startsWith("/u") || normalizedInput.startsWith("!"))) {
            sendError = "Images can be sent with normal messages only.";
            return;
        }

        const ulwCommand = parseUlwCommand(normalizedInput);
        if (ulwCommand?.kind === "stop") {
            ulwLoopRunner.stop(threadId, "user_stop");
            handleStop();
            return;
        }

        if (ulwCommand?.kind === "config") {
            if (
                typeof ulwCommand.maxIterations !== "number" &&
                !ulwCommand.completionPromise
            ) {
                sendError = "Usage: /u config max=30 promise=DONE";
                return;
            }
            const configured = ulwRuntime.configure(threadId, {
                maxIterations: ulwCommand.maxIterations,
                completionPromise: ulwCommand.completionPromise,
            });
            sendError = null;
            console.info(
                `[ulw] defaults updated for ${threadId}: max=${configured.maxIterations}, promise=${configured.completionPromise}`,
            );
            return;
        }

        if (ulwCommand?.kind === "start") {
            const task = ulwCommand.task ?? pickUlwTaskFromMessages(messages.getThreadMessages(threadId));
            if (!task) {
                sendError = "Add a task after /u, or send a normal task message first.";
                return;
            }

            ulwLoopRunner.start(threadId, {
                task,
                maxIterations: ulwCommand.maxIterations,
                completionPromise: ulwCommand.completionPromise,
            }, {
                sendTurn: sendTurnText,
                onTurnComplete: messages.onTurnComplete.bind(messages),
            });
            return;
        }

        const bangCommand = parseBangTerminalCommand(normalizedInput);
        if (bangCommand) {
            if (!bangCommand.command) {
                sendError = "Usage: !<command> or !pwsh|cmd|bash|sh|zsh|fish <command>";
                return;
            }

            if (ulwRuntime.isActive(threadId)) {
                ulwLoopRunner.stop(threadId, "manual_user_input");
            }

            sendTurnText(threadId, buildBangTerminalPrompt(bangCommand));
            return;
        }

        if (ulwRuntime.isActive(threadId)) {
            ulwLoopRunner.stop(threadId, "manual_user_input");
        }

        sendTurnText(threadId, normalizedInput, imageInputs);
    }

    function handleStop() {
        if (!threadId) return;
        if (ulwRuntime.isActive(threadId)) {
            ulwLoopRunner.stop(threadId, "user_interrupt");
        }
        const result = messages.interrupt(threadId);
        if (!result.success) {
            sendError = result.error ?? "Failed to stop turn";
        }
    }

    function handlePlanApprove(messageId: string) {
        messages.approvePlan(messageId);
        modeUserOverride = true;
        mode = "code";
        handleSubmit("Approved. Proceed with implementation.");
    }

    const lastPlanId = $derived.by(() => {
        const msgs = messages.current;
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].kind === "plan") return msgs[i].id;
        }
        return null;
    });

    // Auto-sync mode to "plan" when the thread has an active plan
    $effect(() => {
        if (!lastPlanId) return;
        // New plan arrived — reset user override
        if (lastPlanId !== trackedPlanId) {
            trackedPlanId = lastPlanId;
            modeUserOverride = false;
        }
        if (modeUserOverride) return;
        const msgs = messages.current;
        const planIdx = msgs.findIndex((m) => m.id === lastPlanId);
        // If nothing meaningful came after the plan, stay in plan mode
        const hasFollowUp = msgs.slice(planIdx + 1).some(
            (m) => m.role === "user" || (m.role === "assistant" && m.kind !== "reasoning")
        );
        if (!hasFollowUp) {
            mode = "plan";
        }
    });

    $effect(() => {
        if (socket.status === "connected") {
            sendError = null;
        }
    });

</script>

<svelte:head>
    <title>Thread {threadShortId} — Codex Remote</title>
</svelte:head>

<div class="thread-page stack">
    <AppHeader
        status={socket.status}
        threadId={threadId}
        {sandbox}
        onSandboxChange={(v) => sandbox = v}
    >
        {#snippet actions()}
            <a href="/settings">Settings</a>
            <button type="button" onclick={() => theme.cycle()} title="Theme: {theme.current}">
                {themeIcons[theme.current]}
            </button>
        {/snippet}
    </AppHeader>

    <main class="thread-main">
        <section class="thread-shell stack">
            <header class="thread-masthead">
                <span class="thread-kicker">Thread workspace</span>
                <h1 class="thread-title">
                    <span class="thread-title-main">DIALOGUE</span>
                    <span class="thread-title-sub">session {threadShortId}</span>
                </h1>
                <div class="thread-meta row">
                    <span class="meta-chip">{threadStatusLabel}</span>
                    <span class="meta-sep">·</span>
                    <span class="meta-label">mode {mode}</span>
                    <span class="meta-sep">·</span>
                    <span class="meta-label">sandbox {sandbox}</span>
                </div>
            </header>

            <section class="thread-console stack">
                <div class="transcript" bind:this={container}>
                    {#if messages.current.length === 0}
                        <div class="empty stack">
                            <span class="empty-word">BEGIN</span>
                            <p class="empty-text">No messages yet. Write the first prompt to start this session.</p>
                        </div>
                    {:else}
                        {#each messages.current as message (message.id)}
                            {#if message.role === "approval" && message.approval}
                                <ApprovalPrompt
                                    approval={message.approval}
                                    onApprove={(forSession) => messages.approve(
                                        message.approval!.id,
                                        forSession,
                                        model.trim() ? threads.resolveCollaborationMode(mode, model.trim(), reasoningEffort) : undefined,
                                    )}
                                    onDecline={() => messages.decline(
                                        message.approval!.id,
                                        model.trim() ? threads.resolveCollaborationMode(mode, model.trim(), reasoningEffort) : undefined,
                                    )}
                                    onCancel={() => messages.cancel(message.approval!.id)}
                                />
                            {:else if message.kind === "user-input-request" && message.userInputRequest}
                                <UserInputPrompt
                                    request={message.userInputRequest}
                                    onSubmit={(answers) => messages.respondToUserInput(
                                        message.id,
                                        answers,
                                        model.trim() ? threads.resolveCollaborationMode(mode, model.trim(), reasoningEffort) : undefined,
                                    )}
                                />
                            {:else if message.kind === "plan"}
                                <PlanCard
                                    {message}
                                    disabled={(messages.turnStatus ?? "").toLowerCase() === "inprogress" || !socket.isHealthy}
                                    latest={message.id === lastPlanId}
                                    onApprove={() => handlePlanApprove(message.id)}
                                />
                            {:else}
                                <MessageBlock {message} />
                            {/if}
                        {/each}

                        {#if messages.isReasoningStreaming}
                            <div class="streaming-reasoning">
                                <Reasoning
                                    content={messages.streamingReasoningText}
                                    isStreaming={true}
                                    defaultOpen={true}
                                />
                            </div>
                        {/if}

                        {#if (messages.turnStatus ?? "").toLowerCase() === "inprogress" && !messages.isReasoningStreaming}
                            <WorkingStatus
                                detail={messages.statusDetail ?? messages.planExplanation}
                                plan={messages.plan}
                                startTime={turnStartTime}
                            />
                        {/if}
                    {/if}

                    {#if sendError || (socket.status !== "connected" && socket.status !== "connecting" && socket.error)}
                        <div class="connection-error row">
                            <span class="error-icon row">!</span>
                            <span class="error-text">{sendError || socket.error}</span>
                            {#if socket.status === "reconnecting"}
                                <span class="error-hint">Reconnecting automatically...</span>
                            {:else if socket.status === "error" || socket.status === "disconnected"}
                                <button type="button" class="retry-btn" onclick={() => socket.reconnect()}>
                                    Retry
                                </button>
                            {/if}
                        </div>
                    {/if}
                </div>

                <div class="composer">
                    <PromptInput
                        {model}
                        {reasoningEffort}
                        {mode}
                        modelOptions={models.options}
                        modelsLoading={models.status === "loading"}
                        disabled={(messages.turnStatus ?? "").toLowerCase() === "inprogress" || !socket.isHealthy}
                        onStop={(messages.turnStatus ?? "").toLowerCase() === "inprogress" ? handleStop : undefined}
                        onSubmit={handleSubmit}
                        onModelChange={(v) => model = v}
                        onReasoningChange={(v) => reasoningEffort = v}
                        onModeChange={(v) => { modeUserOverride = true; mode = v; }}
                    />
                </div>
            </section>
        </section>
    </main>
</div>

<style>
    .thread-page {
        --stack-gap: 0;
        min-height: 100vh;
        background: var(--cli-bg);
    }

    .thread-main {
        flex: 1;
        display: flex;
        justify-content: center;
        padding: var(--space-md) var(--space-lg);
    }

    .thread-shell {
        --stack-gap: var(--space-sm);
        width: 100%;
        max-width: min(1480px, calc(100vw - var(--space-lg) * 2));
        animation: threadFadeUp 0.28s ease;
    }

    .thread-masthead {
        display: grid;
        gap: 0.28rem;
        padding: 0.22rem 0;
    }

    .thread-kicker {
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.11em;
        color: var(--cli-text-muted);
    }

    .thread-title {
        margin: 0;
        display: grid;
        gap: 0.12rem;
    }

    .thread-title-main {
        font-family: var(--font-display);
        font-size: clamp(2.4rem, 8vw, 5.8rem);
        line-height: 0.82;
        text-transform: uppercase;
        letter-spacing: -0.015em;
        color: var(--cli-text);
    }

    .thread-title-sub {
        font-family: var(--font-editorial);
        font-size: clamp(1.06rem, 2vw, 1.64rem);
        font-style: italic;
        color: var(--cli-text-dim);
        letter-spacing: 0.006em;
    }

    .thread-meta {
        --row-gap: var(--space-xs);
        flex-wrap: wrap;
        color: var(--cli-text-muted);
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        letter-spacing: 0.05em;
        text-transform: uppercase;
    }

    .meta-chip {
        padding: 0.16rem 0.42rem;
        border: 1px solid color-mix(in srgb, var(--cli-border) 54%, transparent);
        border-radius: 999px;
        color: var(--cli-prefix-agent);
        background: color-mix(in srgb, var(--cli-prefix-agent) 10%, transparent);
    }

    .meta-sep {
        color: var(--cli-border);
    }

    .meta-label {
        color: var(--cli-text-dim);
    }

    .thread-console {
        --stack-gap: 0;
        border: 1px solid color-mix(in srgb, var(--cli-border) 72%, transparent);
        border-radius: var(--radius-lg);
        background:
            linear-gradient(
                180deg,
                color-mix(in srgb, var(--cli-bg-elevated) 90%, transparent),
                color-mix(in srgb, var(--cli-bg) 92%, transparent)
            );
        overflow: hidden;
        min-height: min(72vh, 980px);
    }

    :global(:root[data-theme="light"]) .thread-console {
        box-shadow: var(--shadow-md);
    }

    .transcript {
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
        min-height: 18rem;
        padding: var(--space-sm) 0 var(--space-md);
        background: transparent;
    }

    .composer {
        border-top: 1px solid color-mix(in srgb, var(--cli-border) 70%, transparent);
        background: color-mix(in srgb, var(--cli-bg-elevated) 86%, transparent);
    }

    .composer :global(.prompt-input) {
        padding: 0;
    }

    .composer :global(.input-container) {
        border: 0;
        border-radius: 0;
        box-shadow: none;
        background: transparent;
    }

    .composer :global(.input-container:focus-within) {
        transform: none;
        box-shadow: none;
    }

    .composer :global(textarea) {
        min-height: 3.6rem;
    }

    .streaming-reasoning {
        padding: var(--space-xs) var(--space-md);
    }

    .empty {
        --stack-gap: var(--space-xs);
        align-items: flex-start;
        padding: clamp(2rem, 8vh, 4rem) var(--space-md);
    }

    .empty-word {
        font-family: var(--font-display);
        font-size: clamp(2rem, 7vw, 3.8rem);
        line-height: 0.86;
        letter-spacing: -0.01em;
        color: color-mix(in srgb, var(--cli-text) 82%, transparent);
    }

    .empty-text {
        margin: 0;
        max-width: 42ch;
        color: var(--cli-text-dim);
        font-family: var(--font-editorial);
        font-size: 1rem;
        line-height: 1.45;
    }

    .connection-error {
        --row-gap: var(--space-sm);
        margin: var(--space-md) var(--space-md) 0;
        padding: var(--space-sm) var(--space-md);
        background: var(--cli-error-bg);
        border: 1px solid color-mix(in srgb, var(--cli-error) 56%, transparent);
        border-radius: var(--radius-md);
        font-family: var(--font-mono);
        font-size: var(--text-sm);
    }

    .error-icon {
        justify-content: center;
        width: 1.25rem;
        height: 1.25rem;
        background: var(--cli-error);
        color: white;
        border-radius: 50%;
        font-size: var(--text-xs);
        font-weight: bold;
        flex-shrink: 0;
        --row-gap: 0;
    }

    .error-text {
        color: var(--cli-error);
        flex: 1;
    }

    .error-hint {
        color: var(--cli-text-muted);
        font-size: var(--text-xs);
    }

    .retry-btn {
        padding: var(--space-xs) var(--space-sm);
        background: transparent;
        border: 1px solid var(--cli-error);
        border-radius: var(--radius-sm);
        color: var(--cli-error);
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        cursor: pointer;
        transition: all var(--transition-fast);
    }

    .retry-btn:hover {
        background: var(--cli-error);
        color: white;
    }

    @keyframes threadFadeUp {
        from {
            opacity: 0;
            transform: translateY(10px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }

    @media (max-width: 900px) {
        .thread-main {
            padding: var(--space-md);
        }

        .thread-shell {
            max-width: 100%;
        }

        .thread-title-main {
            font-size: clamp(2rem, 14vw, 3.6rem);
        }

        .thread-console {
            min-height: calc(100vh - 13rem);
        }
    }

</style>
