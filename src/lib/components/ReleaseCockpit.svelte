<script lang="ts">
  import type { ReleaseInspectResult, ReleaseStartParams, ReleaseStatusResult } from "../types";

  type Props = {
    connected: boolean;
    canManage: boolean;
    inspect: ReleaseInspectResult | null;
    status: ReleaseStatusResult | null;
    inspectLoading: boolean;
    startLoading: boolean;
    statusLoading: boolean;
    polling: boolean;
    error: string | null;
    info: string | null;
    onInspect: (params: { repoPath?: string; targetRef?: string; tag?: string }) => void;
    onStart: (params: ReleaseStartParams) => void;
    onPoll: () => void;
    onStartPolling: () => void;
    onStopPolling: () => void;
  };

  const {
    connected,
    canManage,
    inspect,
    status,
    inspectLoading,
    startLoading,
    statusLoading,
    polling,
    error,
    info,
    onInspect,
    onStart,
    onPoll,
    onStartPolling,
    onStopPolling,
  }: Props = $props();

  let repoPath = $state("");
  let targetRef = $state("");
  let tag = $state("");
  let dryRun = $state(false);

  $effect(() => {
    if (!repoPath && inspect?.repoPath) {
      repoPath = inspect.repoPath;
    }
  });

  function statusTone(value: string): "ok" | "warn" | "fail" | "neutral" {
    const lower = value.trim().toLowerCase();
    if (!lower) return "neutral";
    if (lower.includes("pass") || lower.includes("ok") || lower.includes("ready") || lower.includes("success")) return "ok";
    if (lower.includes("warn")) return "warn";
    if (lower.includes("fail") || lower.includes("error") || lower.includes("blocked")) return "fail";
    return "neutral";
  }

  function formatTs(value: string): string {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return value;
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function handleInspect() {
    onInspect({
      ...(repoPath.trim() ? { repoPath: repoPath.trim() } : {}),
      ...(targetRef.trim() ? { targetRef: targetRef.trim() } : {}),
      ...(tag.trim() ? { tag: tag.trim() } : {}),
    });
  }

  function handleStart() {
    onStart({
      ...(repoPath.trim() ? { repoPath: repoPath.trim() } : {}),
      ...(targetRef.trim() ? { targetRef: targetRef.trim() } : {}),
      ...(tag.trim() ? { tag: tag.trim() } : {}),
      ...(dryRun ? { dryRun: true } : {}),
    });
  }
</script>

<div class="section stack">
  <div class="section-header">
    <span class="section-index">05</span>
    <span class="section-title">Release Cockpit</span>
  </div>
  <div class="section-body stack">
    {#if !connected}
      <p class="hint">Connect first to inspect and run releases.</p>
    {:else if !canManage}
      <p class="hint">Select a device to run release checks on that machine.</p>
    {:else}
      <div class="field-grid">
        <div class="field stack">
          <label for="release-repo">Repo path</label>
          <input id="release-repo" type="text" bind:value={repoPath} placeholder="D:\\REALPROJECTS\\zane" />
        </div>
        <div class="field stack">
          <label for="release-ref">Target ref</label>
          <input id="release-ref" type="text" bind:value={targetRef} placeholder="main" />
        </div>
        <div class="field stack">
          <label for="release-tag">Tag (optional)</label>
          <input id="release-tag" type="text" bind:value={tag} placeholder="v1.2.3" />
        </div>
      </div>

      <label class="toggle row">
        <input type="checkbox" bind:checked={dryRun} />
        <span>Dry run</span>
      </label>

      <div class="connect-actions row">
        <button class="action-btn" type="button" onclick={handleInspect} disabled={inspectLoading || startLoading}>
          {inspectLoading ? "Inspecting..." : "Inspect readiness"}
        </button>
        <button class="action-btn" type="button" onclick={handleStart} disabled={startLoading || inspectLoading}>
          {startLoading ? "Starting..." : "Start release"}
        </button>
        <button class="action-btn" type="button" onclick={onPoll} disabled={!status?.releaseId || statusLoading}>
          {statusLoading ? "Polling..." : "Poll status"}
        </button>
        {#if polling}
          <button class="action-btn" type="button" onclick={onStopPolling}>Stop auto-poll</button>
        {:else}
          <button class="action-btn" type="button" onclick={onStartPolling} disabled={!status?.releaseId}>Auto-poll</button>
        {/if}
      </div>

      {#if inspect}
        <div class="status-card stack">
          <div class="row readiness-row">
            <span class="status-label">Readiness</span>
            <span class="badge {inspect.ready ? 'ok' : 'warn'}">{inspect.ready ? "Ready" : "Needs fixes"}</span>
          </div>
          {#if inspect.branch}
            <p class="hint">Branch: <code>{inspect.branch}</code></p>
          {/if}
          {#if inspect.checks.length > 0}
            <ul class="check-list">
              {#each inspect.checks as check (check.id)}
                <li>
                  <span class="check-label">{check.label}</span>
                  <span class="badge {statusTone(check.status)}">{check.status}</span>
                  {#if check.detail}
                    <p class="hint">{check.detail}</p>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
          {#if inspect.notes.length > 0}
            <ul class="note-list">
              {#each inspect.notes as note}
                <li>{note}</li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}

      {#if status}
        <div class="status-card stack">
          <div class="row readiness-row">
            <span class="status-label">Release {status.releaseId}</span>
            <span class="badge {statusTone(status.status)}">{status.status}</span>
            {#if status.phase}
              <span class="badge neutral">{status.phase}</span>
            {/if}
          </div>

          {#if status.logs.length > 0}
            <div class="log-list">
              {#each status.logs as log (log.id)}
                <div class="log-line">
                  <span class="log-ts">{formatTs(log.ts)}</span>
                  <span class="log-level">{log.level}</span>
                  <span class="log-message">{log.message}</span>
                </div>
              {/each}
            </div>
          {/if}

          {#if status.assets.length > 0}
            <div class="asset-wrap stack">
              <span class="status-label">Assets</span>
              <ul class="asset-list">
                {#each status.assets as asset (asset.id)}
                  <li>
                    <span>{asset.label}</span>
                    {#if asset.href}
                      <a href={asset.href} target="_blank" rel="noreferrer">Open</a>
                    {:else if asset.path}
                      <code>{asset.path}</code>
                    {/if}
                  </li>
                {/each}
              </ul>
            </div>
          {/if}

          {#if status.links.length > 0}
            <div class="asset-wrap stack">
              <span class="status-label">Links</span>
              <ul class="asset-list">
                {#each status.links as link (link.id)}
                  <li>
                    <span>{link.label}</span>
                    {#if link.href}
                      <a href={link.href} target="_blank" rel="noreferrer">Open</a>
                    {/if}
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        </div>
      {/if}

      {#if info}
        <p class="hint hint-local">{info}</p>
      {/if}
      {#if error}
        <p class="hint hint-error">{error}</p>
      {/if}
    {/if}
  </div>
</div>

<style>
  .section {
    --stack-gap: 0;
    border: 1px solid color-mix(in srgb, var(--cli-border) 46%, transparent);
    border-radius: var(--radius-md);
    overflow: hidden;
    background: color-mix(in srgb, var(--cli-bg-elevated) 78%, transparent);
  }

  .section-header {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: var(--space-sm) var(--space-md);
    background: color-mix(in srgb, var(--cli-bg-elevated) 90%, var(--cli-bg));
    border-bottom: 1px solid color-mix(in srgb, var(--cli-border) 46%, transparent);
  }

  .section-index {
    font-family: var(--font-mono);
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.11em;
    color: var(--cli-prefix-agent);
    font-weight: 600;
  }

  .section-title {
    font-family: var(--font-display);
    font-size: 1.15rem;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    color: var(--cli-text);
    font-weight: 500;
  }

  .section-body {
    --stack-gap: var(--space-md);
    padding: var(--space-md);
  }

  .field-grid {
    display: grid;
    gap: var(--space-sm);
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .field {
    --stack-gap: var(--space-xs);
  }

  .field label {
    font-family: var(--font-mono);
    color: var(--cli-text-dim);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
  }

  .field input {
    padding: 0.55rem 0.62rem;
    background: var(--cli-bg);
    border: 1px solid var(--cli-border);
    border-radius: var(--radius-md);
    color: var(--cli-text);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
  }

  .field input:focus {
    outline: none;
    border-color: var(--cli-prefix-agent);
  }

  .toggle {
    --row-gap: var(--space-xs);
    font-family: var(--font-sans);
    font-size: 0.84rem;
    color: var(--cli-text-dim);
    width: fit-content;
  }

  .connect-actions {
    align-items: center;
    gap: var(--space-sm);
    flex-wrap: wrap;
  }

  .action-btn {
    padding: var(--space-xs) var(--space-sm);
    background: transparent;
    border: 1px solid color-mix(in srgb, var(--cli-border) 72%, transparent);
    border-radius: var(--radius-md);
    color: var(--cli-text);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.035em;
    font-weight: 600;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .action-btn:hover:enabled {
    background: var(--cli-bg-hover);
    border-color: var(--cli-text-muted);
  }

  .action-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .status-card {
    --stack-gap: var(--space-sm);
    border: 1px solid color-mix(in srgb, var(--cli-border) 62%, transparent);
    border-radius: var(--radius-md);
    padding: var(--space-sm);
    background: color-mix(in srgb, var(--cli-bg) 88%, transparent);
  }

  .readiness-row {
    --row-gap: var(--space-xs);
    flex-wrap: wrap;
  }

  .status-label {
    color: var(--cli-text-dim);
    font-family: var(--font-mono);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.07em;
  }

  .badge {
    border: 1px solid color-mix(in srgb, var(--cli-border) 68%, transparent);
    border-radius: 999px;
    padding: 0.08rem 0.4rem;
    font-family: var(--font-mono);
    font-size: 0.64rem;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--cli-text-dim);
  }

  .badge.ok {
    color: var(--cli-success);
    border-color: color-mix(in srgb, var(--cli-success) 50%, var(--cli-border));
  }

  .badge.warn {
    color: var(--cli-warning);
    border-color: color-mix(in srgb, var(--cli-warning) 54%, var(--cli-border));
  }

  .badge.fail {
    color: var(--cli-error);
    border-color: color-mix(in srgb, var(--cli-error) 54%, var(--cli-border));
  }

  .badge.neutral {
    color: var(--cli-text-dim);
  }

  .check-list,
  .note-list,
  .asset-list {
    margin: 0;
    padding-left: 1.05rem;
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    color: var(--cli-text-dim);
    font-family: var(--font-sans);
    font-size: 0.82rem;
  }

  .check-label {
    color: var(--cli-text);
    margin-right: var(--space-xs);
  }

  .log-list {
    max-height: 11.5rem;
    overflow: auto;
    border: 1px solid color-mix(in srgb, var(--cli-border) 58%, transparent);
    border-radius: var(--radius-md);
    padding: var(--space-xs);
    background: color-mix(in srgb, var(--cli-bg-elevated) 90%, transparent);
  }

  .log-line {
    display: grid;
    grid-template-columns: auto auto 1fr;
    gap: var(--space-xs);
    padding: 0.12rem 0.2rem;
    font-family: var(--font-mono);
    font-size: 0.68rem;
    color: var(--cli-text-dim);
    line-height: 1.45;
  }

  .log-ts {
    color: var(--cli-text-muted);
    white-space: nowrap;
  }

  .log-level {
    text-transform: uppercase;
  }

  .log-message {
    color: var(--cli-text);
    font-family: var(--font-sans);
    font-size: 0.8rem;
  }

  .asset-wrap {
    --stack-gap: var(--space-xs);
  }

  .asset-list li {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex-wrap: wrap;
  }

  .asset-list a {
    color: var(--cli-prefix-agent);
  }

  .asset-list code {
    color: var(--cli-text-muted);
    background: var(--cli-bg-elevated);
    padding: 1px 4px;
    border-radius: var(--radius-md);
    font-family: var(--font-mono);
    font-size: 0.68rem;
  }

  .hint {
    color: var(--cli-text-muted);
    font-size: 0.78rem;
    line-height: 1.5;
    margin: 0;
    font-family: var(--font-sans);
  }

  .hint-error {
    color: var(--cli-error);
  }

  .hint-local {
    color: var(--cli-success, #4ade80);
  }

  .hint code {
    color: var(--cli-text-dim);
    background: var(--cli-bg-elevated);
    padding: 1px 4px;
    border-radius: var(--radius-md);
    font-family: var(--font-mono);
  }

  @media (max-width: 900px) {
    .field-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
