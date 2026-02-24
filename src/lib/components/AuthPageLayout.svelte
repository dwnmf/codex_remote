<script lang="ts">
    import type { Snippet } from "svelte";
    import { theme } from "../theme.svelte";

    const themeIcons = { system: "◐", light: "○", dark: "●" } as const;

    const { children }: { children: Snippet } = $props();
</script>

<div class="login-page">
  <div class="login-left">
    <div class="login-form-wrapper">
      <header class="login-header">
        <a class="brand" href="/">zane</a>
        <button type="button" class="icon-btn" onclick={() => theme.cycle()} title="Theme: {theme.current}">
          <span class="icon-glyph">{themeIcons[theme.current]}</span>
        </button>
      </header>

      <div class="login-content stack">
        {@render children()}
      </div>

      <footer class="login-footer">
        <a class="footer-link" href="https://github.com/cospec-ai/zane" target="_blank" rel="noopener">GitHub</a>
      </footer>
    </div>
  </div>

  <div class="login-right">
    <div class="login-visual">
      <div class="visual-text">
        <span class="visual-label">Remote control for your local Codex.</span>
        <span class="visual-desc">Start and supervise Codex CLI sessions from any device.</span>
      </div>
    </div>
  </div>
</div>

<style>
  .login-page {
    display: flex;
    min-height: 100vh;
    width: 100vw;
    position: fixed;
    inset: 0;
    background: var(--cli-bg);
    color: var(--cli-text);
    font-family: var(--font-sans);
  }

  .login-left {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-lg) var(--space-md);
  }

  .login-form-wrapper {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 380px;
    min-height: calc(100vh - var(--space-lg) * 2);
  }

  .login-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: auto;
  }

  .brand {
    font-family: var(--font-display);
    font-size: 1rem;
    font-weight: 400;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: var(--cli-prefix-agent);
    text-decoration: none;
  }

  .icon-btn {
    background: transparent;
    border: 2px solid var(--cli-border);
    color: var(--cli-text);
    border-radius: var(--radius-sm);
    padding: var(--space-xs) var(--space-sm);
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
  }

  .login-footer {
    margin-top: auto;
    padding-top: var(--space-lg);
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

  /* Right panel */
  .login-right {
    flex: 1;
    display: none;
  }

  @media (min-width: 768px) {
    .login-right {
      display: flex;
    }
  }

  .login-visual {
    flex: 1;
    display: flex;
    align-items: flex-end;
    justify-content: flex-start;
    padding: var(--space-xl);
    background: var(--cli-bg-elevated);
    border-left: 2px solid var(--cli-border);
    position: relative;
    overflow: hidden;
  }

  .login-visual::before {
    content: "";
    position: absolute;
    inset: 0;
    background:
      repeating-linear-gradient(
        0deg,
        transparent,
        transparent 44px,
        color-mix(in srgb, var(--cli-border) 35%, transparent) 44px,
        color-mix(in srgb, var(--cli-border) 35%, transparent) 45px
      ),
      repeating-linear-gradient(
        90deg,
        transparent,
        transparent 44px,
        color-mix(in srgb, var(--cli-border) 20%, transparent) 44px,
        color-mix(in srgb, var(--cli-border) 20%, transparent) 45px
      );
    opacity: 0.9;
  }

  .visual-text {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
  }

  .visual-label {
    font-size: clamp(1.25rem, 2vw, 1.75rem);
    font-family: var(--font-display);
    font-weight: 400;
    line-height: 1.15;
    letter-spacing: -0.01em;
  }

  .visual-desc {
    font-size: var(--text-sm);
    color: var(--cli-text-dim);
    line-height: 1.5;
  }
</style>
