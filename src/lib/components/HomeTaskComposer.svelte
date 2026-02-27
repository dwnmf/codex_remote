<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import type { ModeKind, ModelOption } from "../types";

  interface Props {
    task: string;
    mode: ModeKind;
    isCreating: boolean;
    canSubmit: boolean;
    worktreeDisplay: string;
    currentModelLabel: string;
    modelsStatus: string;
    modelOptions: ModelOption[];
    selectedModel: string;
  }

  const {
    task,
    mode,
    isCreating,
    canSubmit,
    worktreeDisplay,
    currentModelLabel,
    modelsStatus,
    modelOptions,
    selectedModel,
  }: Props = $props();

  const dispatch = createEventDispatcher<{
    submit: void;
    taskChange: { value: string };
    toggleMode: void;
    openWorktrees: void;
    selectModel: { value: string };
  }>();

  let modelOpen = $state(false);

  function handleTaskKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      dispatch("submit");
    }
  }

  function handleWindowClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (!target.closest(".dropdown")) modelOpen = false;
  }
</script>

<svelte:window onclick={handleWindowClick} />

<form
  class="input-card stack"
  onsubmit={(e) => {
    e.preventDefault();
    dispatch("submit");
  }}
>
  <textarea
    value={task}
    oninput={(e) => {
      const value = (e.currentTarget as HTMLTextAreaElement).value;
      dispatch("taskChange", { value });
    }}
    onkeydown={handleTaskKeydown}
    placeholder="Fix a bug, build a feature, refactor code... (or /u <task>)"
    rows="3"
    disabled={isCreating}
  ></textarea>

  <div class="input-footer split">
    <div class="tools row">
      <!-- Model Selector -->
      <div class="dropdown" class:open={modelOpen}>
        <button
          type="button"
          class="tool-btn row"
          onclick={(e) => {
            e.stopPropagation();
            modelOpen = !modelOpen;
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4Z" />
            <circle cx="12" cy="14" r="2" />
          </svg>
          <span class="tool-key">Model</span>
          <span class="tool-value collapsible-label">{currentModelLabel}</span>
          <svg class="chevron collapsible-label" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {#if modelOpen}
          <div class="dropdown-menu">
            {#if modelsStatus === "loading"}
              <div class="dropdown-empty">Loading...</div>
            {:else if modelOptions.length === 0}
              <div class="dropdown-empty">No models available</div>
            {:else}
              {#each modelOptions as option}
                <button
                  type="button"
                  class="dropdown-item split"
                  class:selected={selectedModel === option.value}
                  onclick={() => {
                    dispatch("selectModel", { value: option.value });
                    modelOpen = false;
                  }}
                >
                  {option.label}
                  {#if selectedModel === option.value}
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  {/if}
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      </div>

      <!-- Mode Toggle -->
      <button
        type="button"
        class="tool-btn mode-toggle row"
        class:active={mode === "plan"}
        onclick={() => dispatch("toggleMode")}
      >
        {#if mode === "plan"}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
            <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
          </svg>
          <span>Plan</span>
        {:else}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
          <span>Code</span>
        {/if}
      </button>
    </div>

    <button type="submit" class="submit-btn row" disabled={!canSubmit}>
      {#if isCreating}
        <svg class="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
      {:else}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="m6 17 5-5-5-5" />
          <path d="m13 17 5-5-5-5" />
        </svg>
      {/if}
    </button>
  </div>
</form>

<button type="button" class="chip" onclick={() => dispatch("openWorktrees")}>
  <svg class="chip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
  <span class="tool-key">Project</span>
  <span class="tool-value">{worktreeDisplay}</span>
</button>

<style>
  .input-card {
    --stack-gap: 0;
    width: 100%;
    position: relative;
    border: 1px solid color-mix(in srgb, var(--cli-border) 70%, transparent);
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--cli-bg-elevated) 86%, var(--cli-bg));
    box-shadow: var(--shadow-sm);
    transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  }

  .input-card::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    background:
      linear-gradient(
        180deg,
        color-mix(in srgb, var(--cli-bg-elevated) 46%, transparent),
        transparent 56%
      );
    opacity: 0.5;
  }

  .input-card:focus-within {
    border-color: var(--cli-prefix-agent);
    box-shadow:
      var(--shadow-focus),
      var(--shadow-sm);
  }

  .input-card textarea {
    flex: 1;
    display: block;
    width: 100%;
    position: relative;
    z-index: 1;
    padding: 1rem 1.06rem 1.08rem;
    background: transparent;
    border: none;
    color: var(--cli-text);
    font-family: var(--font-editorial);
    font-size: clamp(1.24rem, 2.8vw, 1.8rem);
    font-weight: 420;
    line-height: 1.34;
    resize: vertical;
    min-height: 7.2rem;
    letter-spacing: -0.01em;
  }

  .input-card textarea:focus {
    outline: none;
  }

  .input-card textarea::placeholder {
    color: var(--cli-text-muted);
    font-family: var(--font-editorial);
    font-style: italic;
    font-weight: 360;
    letter-spacing: 0.003em;
  }

  .input-card textarea:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .input-footer {
    --split-gap: var(--space-sm);
    position: relative;
    z-index: 1;
    padding: 0.58rem var(--space-md);
    border-top: 1px solid var(--cli-border);
  }

  .tools {
    --row-gap: var(--space-xs);
  }

  .tool-btn {
    --row-gap: var(--space-xs);
    padding: 0.32rem 0.56rem;
    background: transparent;
    border: 1px solid color-mix(in srgb, var(--cli-border) 52%, transparent);
    border-radius: var(--radius-md);
    color: var(--cli-text-dim);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .tool-btn:hover {
    background: var(--cli-bg-hover);
    color: var(--cli-text);
    border-color: color-mix(in srgb, var(--cli-border) 72%, transparent);
  }

  .tool-btn svg {
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
  }

  .tool-btn .chevron {
    width: 0.75rem;
    height: 0.75rem;
    opacity: 0.5;
  }

  .tool-key {
    color: var(--cli-text-muted);
    font-weight: 500;
  }

  .tool-value {
    color: var(--cli-text);
    max-width: 12rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mode-toggle.active {
    background: color-mix(in srgb, var(--cli-text) 10%, transparent);
    color: var(--cli-text);
    border-color: color-mix(in srgb, var(--cli-text) 30%, var(--cli-border));
  }

  .submit-btn {
    justify-content: center;
    width: 2.2rem;
    height: 2.2rem;
    padding: 0;
    background: var(--color-btn-primary-bg);
    border: 1px solid var(--cli-border);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: opacity var(--transition-fast);
    --row-gap: 0;
  }

  .submit-btn svg {
    width: 1rem;
    height: 1rem;
    color: var(--color-btn-primary-text);
  }

  .submit-btn:hover:not(:disabled) {
    opacity: 0.85;
  }

  .submit-btn:disabled {
    opacity: 1;
    background: color-mix(in srgb, var(--color-btn-primary-bg) 45%, var(--cli-bg-elevated));
    border-color: color-mix(in srgb, var(--cli-border) 72%, transparent);
    cursor: not-allowed;
  }

  /* Worktree chip */

  .chip {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: var(--space-xs);
    max-width: min(100%, 26rem);
    margin-top: 0.46rem;
    padding: 0.34rem 0.6rem;
    border: 1px solid color-mix(in srgb, var(--cli-border) 52%, transparent);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--cli-text-dim);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .chip:hover {
    background: var(--cli-bg-hover);
    color: var(--cli-text);
    border-color: color-mix(in srgb, var(--cli-border) 72%, transparent);
  }

  .chip-icon {
    width: 0.875rem;
    height: 0.875rem;
    flex-shrink: 0;
  }

  .chip span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Dropdown */

  .dropdown {
    position: relative;
  }

  .dropdown-menu {
    position: absolute;
    bottom: 100%;
    left: 0;
    min-width: 240px;
    margin-bottom: var(--space-xs);
    padding: 0.3rem;
    background: var(--cli-bg-elevated);
    border: 1px solid var(--cli-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-popover);
    z-index: 100;
    animation: fadeIn 0.1s ease;
  }

  .dropdown-item {
    --split-gap: var(--space-sm);
    width: 100%;
    padding: 0.54rem 0.58rem;
    background: transparent;
    border: none;
    border-radius: var(--radius-md);
    color: var(--cli-text);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.01em;
    text-align: left;
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .dropdown-item:hover {
    background: var(--cli-bg-hover);
  }

  .dropdown-item.selected {
    color: var(--cli-prefix-agent);
  }

  .dropdown-item svg {
    width: 0.875rem;
    height: 0.875rem;
    flex-shrink: 0;
  }

  .dropdown-empty {
    padding: var(--space-sm);
    color: var(--cli-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    text-align: center;
  }

  .spinner {
    animation: spin 1s linear infinite;
  }

  @media (max-width: 480px) {
    .collapsible-label {
      display: none;
    }
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
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
