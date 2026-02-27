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
      <div class="brand" aria-label="Codex Remote">
        <span class="brand-main">CODEX</span>
        <span class="brand-accent">Remote</span>
      </div>
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
      <div class="hero-grid">
        <div class="hero-copy stack">
          <h1>
            <span class="hero-kicker">Remote coding control</span>
            <span class="hero-word">REMOTE</span>
            <span class="hero-caption"><span class="hero-script">Codex workflows</span> from any browser</span>
          </h1>
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

        <aside class="hero-visual" aria-label="Highlights">
          <div class="visual-card">
            <span class="visual-icon">◉</span>
            <span class="visual-title">Live Stream</span>
            <span class="visual-copy">Watch each turn as it happens.</span>
          </div>
          <div class="visual-card">
            <span class="visual-icon">◌</span>
            <span class="visual-title">Approve Actions</span>
            <span class="visual-copy">Confirm edits and commands remotely.</span>
          </div>
          <div class="visual-card">
            <span class="visual-icon">◎</span>
            <span class="visual-title">Multi Device</span>
            <span class="visual-copy">Use desktop, tablet, or phone.</span>
          </div>
        </aside>
      </div>
    </main>

    <section class="features">
      <div class="feature">
        <span class="feature-index">01</span>
        <span class="feature-label">Anchor</span>
        <p>A lightweight daemon that spawns and manages Codex CLI sessions. Your code stays local.</p>
      </div>
      <div class="feature">
        <span class="feature-index">02</span>
        <span class="feature-label">Orbit</span>
        <p>A Cloudflare relay that links your browser to Anchor over secure outbound tunnels.</p>
      </div>
      <div class="feature">
        <span class="feature-index">03</span>
        <span class="feature-label">Handheld</span>
        <p>Approve writes, review diffs, and control long-running tasks from your phone.</p>
      </div>
    </section>
  </div>

  <footer class="landing-footer">
    <a class="footer-link" href="https://github.com/dwnmf/codex_remote" target="_blank" rel="noopener">GitHub</a>
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
    --landing-line: color-mix(in srgb, var(--cli-border) 42%, transparent);
    --stack-gap: 0;
    max-width: min(1480px, calc(100vw - var(--space-md) * 2));
    margin: 0 auto;
    border: 1px solid var(--landing-line);
    border-radius: var(--radius-lg);
    background: var(--cli-bg-elevated);
    overflow: hidden;
    box-shadow: var(--shadow-md);
  }

  .landing-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.64rem 0.8rem;
    border-bottom: 1px solid var(--landing-line);
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
  }

  .brand {
    color: var(--cli-prefix-agent);
    display: inline-flex;
    align-items: baseline;
    gap: 0.34rem;
  }

  .brand-main {
    font-family: var(--font-display);
    font-size: 1.22rem;
    font-weight: 600;
    letter-spacing: 0.025em;
    line-height: 1;
  }

  .brand-accent {
    font-family: var(--font-editorial);
    font-size: 1rem;
    font-style: italic;
    font-weight: 500;
    color: var(--cli-text-dim);
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
    border-bottom: 1px solid var(--landing-line);
  }

  .hero-grid {
    width: 100%;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(260px, 360px);
    gap: clamp(var(--space-md), 2.6vw, var(--space-xl));
    align-items: start;
  }

  .hero-copy {
    max-width: 760px;
    --stack-gap: var(--space-md);
  }

  .hero h1 {
    margin: 0;
    display: grid;
    gap: 0.18rem;
    line-height: 0.9;
    text-wrap: balance;
  }

  .hero-kicker {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--cli-text-muted);
  }

  .hero-word {
    font-family: var(--font-editorial);
    font-style: italic;
    font-weight: 700;
    font-size: clamp(3.1rem, 11vw, 6.8rem);
    text-transform: uppercase;
    letter-spacing: -0.018em;
    line-height: 0.86;
    color: var(--cli-text);
  }

  .hero-caption {
    font-family: var(--font-sans);
    font-size: clamp(1.28rem, 2.5vw, 1.82rem);
    line-height: 1.12;
    letter-spacing: -0.006em;
    color: var(--cli-text-dim);
  }

  .hero-script {
    font-family: var(--font-editorial);
    font-style: italic;
    font-weight: 500;
    color: var(--cli-text);
  }

  .hero p {
    margin: 0;
    color: var(--cli-text-dim);
    max-width: 620px;
    line-height: 1.5;
    font-size: 1.03rem;
    font-family: var(--font-sans);
    letter-spacing: 0.003em;
  }

  .hero-visual {
    display: grid;
    gap: var(--space-sm);
  }

  .visual-card {
    display: grid;
    gap: 0.2rem;
    padding: 0.92rem 0.96rem;
    border-radius: var(--radius-md);
    border: 1px solid color-mix(in srgb, var(--cli-border) 36%, transparent);
    background:
      linear-gradient(
        165deg,
        color-mix(in srgb, var(--cli-bg-elevated) 88%, var(--color-text-inverse)),
        color-mix(in srgb, var(--cli-bg) 80%, transparent)
      );
  }

  .visual-icon {
    font-family: var(--font-mono);
    color: var(--cli-prefix-agent);
    font-size: 0.76rem;
    letter-spacing: 0.1em;
  }

  .visual-title {
    font-family: var(--font-sans);
    font-size: 1.08rem;
    font-weight: 700;
    letter-spacing: 0.004em;
    color: var(--cli-text);
  }

  .visual-copy {
    font-family: var(--font-sans);
    font-size: 0.9rem;
    color: var(--cli-text-dim);
    line-height: 1.35;
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
    gap: var(--space-md);
    padding: var(--space-md);
  }

  .feature {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    min-height: 7.5rem;
    padding: 0.88rem 0.92rem;
    border: 1px solid color-mix(in srgb, var(--cli-border) 34%, transparent);
    border-radius: var(--radius-md);
    background:
      linear-gradient(
        170deg,
        color-mix(in srgb, var(--cli-bg-elevated) 90%, var(--color-text-inverse)),
        color-mix(in srgb, var(--cli-bg) 84%, transparent)
      );
    box-shadow: none;
  }

  .feature-label {
    font-family: var(--font-sans);
    font-size: 1.54rem;
    text-transform: uppercase;
    letter-spacing: -0.008em;
    color: var(--cli-text);
    font-weight: 800;
  }

  .feature-index {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--cli-prefix-agent);
  }

  .feature p {
    margin: 0;
    color: var(--cli-text-dim);
    line-height: 1.42;
    font-family: var(--font-sans);
    font-size: 1.02rem;
    letter-spacing: 0.004em;
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

    .hero-grid {
      grid-template-columns: 1fr;
    }

    .hero-visual {
      grid-template-columns: 1fr;
    }

    .hero p {
      font-size: 1.04rem;
    }

    .features {
      grid-template-columns: 1fr;
    }
  }
</style>
