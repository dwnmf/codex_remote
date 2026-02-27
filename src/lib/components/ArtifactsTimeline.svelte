<script lang="ts">
  import type { OrbitArtifact } from "../types";

  type Props = {
    threadId?: string | null;
    artifacts?: OrbitArtifact[];
    loading?: boolean;
    error?: string | null;
    onRefresh?: () => void;
  };

  const {
    threadId = null,
    artifacts = [],
    loading = false,
    error = null,
    onRefresh,
  }: Props = $props();

  function formatTimestamp(iso: string): string {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return iso;
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
</script>

<section class="artifacts-panel stack" aria-live="polite">
  <header class="panel-head row">
    <div class="panel-title-wrap stack">
      <span class="panel-kicker">Thread data</span>
      <h2>Artifacts Timeline</h2>
      {#if threadId}
        <p class="panel-subtle">Thread {threadId.slice(0, 8)}</p>
      {/if}
    </div>
    <button type="button" class="refresh-btn" onclick={() => onRefresh?.()} disabled={loading}>
      {loading ? "Refreshing..." : "Refresh"}
    </button>
  </header>

  {#if error}
    <p class="hint hint-error">{error}</p>
  {/if}

  {#if loading && artifacts.length === 0}
    <p class="hint">Loading artifacts timeline...</p>
  {:else if artifacts.length === 0}
    <p class="hint">No artifacts yet for this thread.</p>
  {:else}
    <ol class="timeline">
      {#each artifacts as artifact (artifact.id)}
        <li class="timeline-item stack">
          <div class="timeline-head row">
            <span class="artifact-title">{artifact.title}</span>
            <span class="artifact-ts">{formatTimestamp(artifact.createdAt)}</span>
          </div>
          <div class="timeline-meta row">
            <span class="meta-chip">{artifact.type}</span>
            {#if artifact.status}
              <span class="meta-chip status">{artifact.status}</span>
            {/if}
          </div>
          {#if artifact.summary}
            <p class="artifact-summary">{artifact.summary}</p>
          {/if}
          {#if artifact.links?.length}
            <div class="artifact-links row">
              {#each artifact.links as link (link.href)}
                <a href={link.href} target="_blank" rel="noreferrer">{link.label}</a>
              {/each}
            </div>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .artifacts-panel {
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

  .refresh-btn {
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

  .refresh-btn:hover:enabled {
    border-color: var(--cli-prefix-agent);
    background: color-mix(in srgb, var(--cli-prefix-agent) 10%, transparent);
  }

  .refresh-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .timeline {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .timeline-item {
    --stack-gap: 0.32rem;
    padding: var(--space-sm);
    border: 1px solid color-mix(in srgb, var(--cli-border) 60%, transparent);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--cli-bg) 80%, transparent);
  }

  .timeline-head {
    justify-content: space-between;
    align-items: baseline;
    gap: var(--space-sm);
  }

  .artifact-title {
    color: var(--cli-text);
    font-family: var(--font-sans);
    font-size: 0.92rem;
    font-weight: 600;
  }

  .artifact-ts {
    color: var(--cli-text-muted);
    font-family: var(--font-mono);
    font-size: 0.66rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .timeline-meta {
    gap: var(--space-xs);
    flex-wrap: wrap;
  }

  .meta-chip {
    font-family: var(--font-mono);
    font-size: 0.64rem;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--cli-text-dim);
    border: 1px solid color-mix(in srgb, var(--cli-border) 68%, transparent);
    border-radius: 999px;
    padding: 0.08rem 0.34rem;
  }

  .meta-chip.status {
    color: var(--cli-prefix-agent);
    border-color: color-mix(in srgb, var(--cli-prefix-agent) 44%, var(--cli-border));
  }

  .artifact-summary {
    margin: 0;
    color: var(--cli-text-dim);
    font-family: var(--font-sans);
    font-size: 0.84rem;
    line-height: 1.45;
  }

  .artifact-links {
    gap: var(--space-xs);
    flex-wrap: wrap;
  }

  .artifact-links a {
    color: var(--cli-prefix-agent);
    font-family: var(--font-mono);
    font-size: 0.68rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    border: 1px solid color-mix(in srgb, var(--cli-border) 68%, transparent);
    border-radius: 999px;
    padding: 0.1rem 0.38rem;
    text-decoration: none;
  }

  .artifact-links a:hover {
    background: color-mix(in srgb, var(--cli-prefix-agent) 10%, transparent);
    border-color: color-mix(in srgb, var(--cli-prefix-agent) 40%, var(--cli-border));
  }

  .hint {
    margin: 0;
    color: var(--cli-text-muted);
    font-family: var(--font-sans);
    font-size: 0.8rem;
    line-height: 1.45;
  }

  .hint-error {
    color: var(--cli-error);
  }
</style>
