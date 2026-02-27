<script lang="ts">
  import { auth } from "../lib/auth.svelte";
  import { config } from "../lib/config.svelte";
  import { theme } from "../lib/theme.svelte";
  import { pwa } from "../lib/pwa.svelte";

  const themeIcons = { system: "◐", light: "○", dark: "●" } as const;

  const isSignedIn = $derived(auth.status === "signed_in");
  const isLocalMode = $derived(auth.isLocalMode);
  const hasConfiguredUrl = $derived(Boolean(config.url?.trim()));
</script>

<svelte:head>
  <title>Codex Remote</title>
</svelte:head>

<div class="landing stack">
  <div class="landing-frame stack">
    <header class="landing-header">
      <div class="brand">codex-remote</div>
      <div class="header-actions">
        {#if pwa.canInstall && !pwa.isStandalone}
          <button class="ghost-btn" type="button" onclick={() => pwa.install()}>Install app</button>
        {/if}
        {#if isSignedIn && isLocalMode && !hasConfiguredUrl}
          <a class="primary-btn" href="/settings">Configure connection</a>
        {:else if isSignedIn}
          <a class="primary-btn" href="/app">Go to app</a>
        {:else}
          <a class="primary-btn" href="/login">Sign in</a>
        {/if}
        <button type="button" class="icon-btn" onclick={() => theme.cycle()} title="Theme: {theme.current}">
          <span class="icon-glyph">{themeIcons[theme.current]}</span>
        </button>
      </div>
    </header>

    <main class="hero stack">
      <div class="hero-copy stack">
        <h1>Remote</h1>
        <p>
          Codex Remote lets you start and supervise Codex CLI sessions running on your machine from any browser.
        </p>
        {#if isLocalMode && !hasConfiguredUrl}
          <div class="hero-actions row">
            <a class="primary-btn" href="/settings">Configure Anchor URL</a>
          </div>
          <p class="local-mode-hint">Local mode active - no sign-in required</p>
        {:else if isLocalMode && hasConfiguredUrl}
          <div class="hero-actions row">
            <a class="primary-btn" href="/app">Go to app</a>
            <a class="ghost-btn" href="/settings">Settings</a>
          </div>
          <p class="local-mode-hint">Local mode active - no sign-in required</p>
        {:else if !isSignedIn}
          <div class="hero-actions row">
            <a class="primary-btn" href="/login">Sign in</a>
            <a class="ghost-btn" href="/register">Create account</a>
          </div>
        {/if}
      </div>
    </main>

    <section class="features">
      <div class="feature">
        <span class="feature-label">Anchor</span>
        <p>A lightweight daemon that spawns and manages Codex CLI sessions. Your code stays local.</p>
      </div>
      <div class="feature">
        <span class="feature-label">Orbit</span>
        <p>A Cloudflare relay that links your browser to Anchor over secure outbound tunnels.</p>
      </div>
      <div class="feature">
        <span class="feature-label">Handheld</span>
        <p>Approve writes, review diffs, and control long-running tasks from your phone.</p>
      </div>
    </section>
  </div>

  <footer class="landing-footer">
    <a class="footer-link" href="https://github.com/cospec-ai/codex-remote" target="_blank" rel="noopener">GitHub</a>
  </footer>
</div>

<style>
  .landing {
    min-height: 100vh;
    background: var(--cli-bg);
    color: var(--cli-text);
    font-family: var(--font-sans);
    padding: var(--space-md);
  }

  .landing-frame {
    --stack-gap: 0;
    max-width: min(1480px, calc(100vw - var(--space-md) * 2));
    margin: 0 auto;
    border: 1px solid var(--cli-border);
    border-radius: var(--radius-lg);
    background: var(--cli-bg-elevated);
    overflow: hidden;
  }

  .landing-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.64rem 0.8rem;
    border-bottom: 1px solid var(--cli-border);
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
  }

  .brand {
    font-family: var(--font-display);
    font-size: 1.08rem;
    font-weight: 600;
    letter-spacing: -0.03em;
    text-transform: none;
    color: var(--cli-prefix-agent);
  }

  .icon-btn {
    background: transparent;
    border: 1px solid var(--cli-border);
    color: var(--cli-text);
    border-radius: var(--radius-md);
    padding: 0.34rem 0.5rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }

  .icon-glyph {
    display: block;
    font-size: var(--text-sm);
    line-height: 1;
    font-family: var(--font-mono);
  }

  .hero {
    align-items: flex-start;
    text-align: left;
    padding: clamp(1.1rem, 4vw, 2.8rem) var(--space-md) var(--space-md);
    border-bottom: 1px solid var(--cli-border);
  }

  .hero-copy {
    max-width: 980px;
    --stack-gap: var(--space-md);
  }

  .hero h1 {
    margin: 0;
    font-size: clamp(3.2rem, 13vw, 9.2rem);
    line-height: 0.84;
    letter-spacing: -0.06em;
    text-wrap: balance;
  }

  .hero p {
    margin: 0;
    color: var(--cli-text-dim);
    max-width: 620px;
    line-height: 1.5;
    font-size: var(--text-base);
  }

  .hero-actions {
    justify-content: flex-start;
    flex-wrap: wrap;
  }

  .local-mode-hint {
    font-size: var(--text-xs);
    color: var(--cli-success, #4ade80);
    margin: 0;
  }

  .primary-btn,
  .ghost-btn {
    padding: 0.48rem 0.7rem;
    border-radius: var(--radius-md);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    line-height: 1;
    cursor: pointer;
    text-decoration: none;
  }

  .primary-btn {
    border: 1px solid var(--cli-border);
    background: var(--color-btn-primary-bg, var(--cli-prefix-agent));
    color: var(--color-btn-primary-text, var(--cli-bg));
    box-shadow: none;
  }

  .ghost-btn {
    background: transparent;
    border: 1px solid var(--cli-border);
    color: var(--cli-text-dim);
    box-shadow: none;
  }

  .primary-btn:hover {
    opacity: 0.9;
  }

  .ghost-btn:hover {
    background: var(--cli-selection);
    color: var(--cli-text);
    border-color: var(--cli-text-muted);
  }

  /* Features */
  .features {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-sm);
    padding: 0.5rem;
  }

  .feature {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    min-height: 7.5rem;
    padding: 0.62rem;
    border: 1px solid var(--cli-border);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--cli-bg) 72%, transparent);
    box-shadow: none;
  }

  .feature-label {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--cli-prefix-agent);
    font-weight: 800;
  }

  .feature p {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--cli-text-dim);
    line-height: 1.5;
  }

  /* Footer */
  .landing-footer {
    margin-top: var(--space-sm);
    padding: 0.45rem var(--space-sm);
    text-align: center;
  }

  .footer-link {
    font-size: var(--text-xs);
    color: var(--cli-text-muted);
    text-decoration: none;
    letter-spacing: 0.04em;
  }

  .footer-link:hover {
    color: var(--cli-text-dim);
  }

  @media (max-width: 900px) {
    .landing {
      padding: var(--space-sm);
    }

    .features {
      grid-template-columns: 1fr;
    }
  }
</style>
