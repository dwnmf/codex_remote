<script lang="ts">
  import { notifications } from "../notifications.svelte";

  const isIos =
    typeof navigator !== "undefined" &&
    /iPad|iPhone|iPod/.test(navigator.userAgent);

  const isStandalone =
    typeof window !== "undefined" &&
    (window.matchMedia("(display-mode: standalone)").matches ||
      ("standalone" in navigator && (navigator as Record<string, unknown>).standalone === true));
</script>

<div class="section stack">
  <div class="section-header">
    <span class="section-index">04</span>
    <span class="section-title">Notifications</span>
  </div>
  <div class="section-body stack">
    {#if isIos && !isStandalone}
      <p class="hint">
        To receive notifications on iOS, add this app to your Home Screen:
        tap the share button, then <strong>Add to Home Screen</strong>.
      </p>
    {/if}

    {#if notifications.pushAvailable}
      <div class="setting-row">
        <span class="setting-label">Push notifications</span>
        {#if notifications.pushSubscribed}
          <div class="btn-group">
            <button type="button" class="action-btn" onclick={() => notifications.unsubscribePush()}>
              Disable
            </button>
            <button type="button" class="action-btn" onclick={() => notifications.sendTestPush()}>
              Test
            </button>
          </div>
        {:else}
          <button type="button" class="action-btn" onclick={() => notifications.subscribePush()}>
            Enable
          </button>
        {/if}
      </div>
    {:else}
      <p class="hint">
        Push notifications are not available{isIos && !isStandalone ? " — install as a Home Screen app first" : ""}.
      </p>
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

  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-sm);
  }

  .setting-label {
    font-size: 0.86rem;
    color: var(--cli-text);
    font-family: var(--font-editorial);
  }

  .action-btn {
    padding: var(--space-xs) var(--space-sm);
    border: 1px solid color-mix(in srgb, var(--cli-border) 72%, transparent);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--cli-text);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.035em;
    font-weight: 600;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .action-btn:hover {
    background: var(--cli-bg-hover);
    color: var(--cli-text);
    border-color: var(--cli-text-muted);
  }

  .btn-group {
    display: flex;
    gap: var(--space-xs);
  }

  .hint {
    color: var(--cli-text-muted);
    font-size: 0.78rem;
    line-height: 1.5;
    margin: 0;
    font-family: var(--font-sans);
  }

  .hint strong {
    color: var(--cli-text-dim);
  }
</style>
