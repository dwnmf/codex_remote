<script lang="ts">
    import type { Snippet } from "svelte";
    import { theme } from "../theme.svelte";

    const themeIcons = { system: "◐", light: "○", dark: "●" } as const;

    const { children }: { children: Snippet } = $props();
</script>

<div class="login-page">
  <div class="login-shell">
    <div class="login-left">
      <div class="login-form-wrapper">
        <header class="login-header">
          <a class="brand" href="/" aria-label="Codex Remote">
            <span class="brand-main">CODEX</span>
            <span class="brand-accent">Remote</span>
          </a>
          <button type="button" class="icon-btn" onclick={() => theme.cycle()} title="Theme: {theme.current}">
            <span class="icon-glyph">{themeIcons[theme.current]}</span>
          </button>
        </header>

        <div class="login-content stack">
          {@render children()}
        </div>

        <footer class="login-footer">
          <a class="footer-link" href="https://github.com/dwnmf/codex_remote" target="_blank" rel="noopener">GitHub</a>
        </footer>
      </div>
    </div>

    <div class="login-right">
      <div class="login-visual">
        <div class="visual-head">
          <span class="visual-watermark">Access</span>
        </div>
        <div class="visual-text">
          <span class="visual-label">Remote control for your local Codex.</span>
          <span class="visual-desc">Start and supervise Codex CLI sessions from any device.</span>
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .login-page {
    min-height: 100vh;
    background: var(--cli-bg);
    color: var(--cli-text);
    font-family: var(--font-sans);
    padding: var(--space-md);
  }

  .login-shell {
    display: flex;
    min-height: calc(100vh - var(--space-md) * 2);
    max-width: min(1480px, calc(100vw - var(--space-md) * 2));
    margin: 0 auto;
    border: 1px solid color-mix(in srgb, var(--cli-border) 72%, transparent);
    border-radius: var(--radius-lg);
    background: var(--cli-bg-elevated);
    overflow: hidden;
  }

  .login-left {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-lg) var(--space-md) var(--space-md);
  }

  .login-form-wrapper {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 420px;
    min-height: 100%;
  }

  .login-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: auto;
  }

  .brand {
    color: var(--cli-prefix-agent);
    text-decoration: none;
    display: inline-flex;
    align-items: baseline;
    gap: 0.34rem;
  }

  .brand-main {
    font-family: var(--font-display);
    font-size: 1.22rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    line-height: 1;
  }

  .brand-accent {
    font-family: var(--font-editorial);
    font-size: 1rem;
    font-style: italic;
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

  .login-content {
    --stack-gap: var(--space-md);
    margin-top: auto;
    margin-bottom: auto;
  }

  .login-footer {
    margin-top: auto;
    padding-top: var(--space-md);
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

  /* Right panel */
  .login-right {
    flex: 1;
    display: none;
    min-width: 0;
  }

  @media (min-width: 768px) {
    .login-right {
      display: flex;
    }
  }

  .login-visual {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: flex-start;
    padding: var(--space-xl);
    background:
      linear-gradient(
        160deg,
        color-mix(in srgb, var(--cli-bg-elevated) 88%, var(--color-text-inverse)),
        color-mix(in srgb, var(--cli-bg) 84%, transparent)
      );
    border-left: 1px solid var(--cli-border);
    position: relative;
    overflow: hidden;
  }

  .visual-head {
    display: grid;
    gap: 0.8rem;
    max-width: 30rem;
  }

  .visual-watermark {
    position: relative;
    font-family: var(--font-display);
    font-size: clamp(3.6rem, 10vw, 7rem);
    line-height: 0.84;
    letter-spacing: -0.008em;
    text-transform: uppercase;
    color: color-mix(in srgb, var(--cli-text) 88%, transparent);
    pointer-events: none;
    white-space: nowrap;
  }

  .visual-text {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
    max-width: 420px;
    margin-top: auto;
    margin-bottom: clamp(0.7rem, 2vh, 1.5rem);
    padding-top: clamp(0.6rem, 1.2vh, 1rem);
  }

  .visual-label {
    font-size: clamp(1.35rem, 2.1vw, 1.9rem);
    font-family: var(--font-editorial);
    font-weight: 400;
    font-style: italic;
    line-height: 1.08;
    letter-spacing: -0.004em;
    max-width: 18ch;
  }

  .visual-desc {
    font-size: 1rem;
    color: var(--cli-text-dim);
    line-height: 1.4;
    max-width: 34ch;
  }
</style>
