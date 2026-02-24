<script lang="ts">
  import { auth } from "../lib/auth.svelte";
  import { navigate } from "../router";
  import AuthPageLayout from "../lib/components/AuthPageLayout.svelte";

  const authMode = (import.meta.env.AUTH_MODE ?? "passkey").toLowerCase();
  let username = $state("");
  const isSignedIn = $derived(auth.status === "signed_in");

  $effect(() => {
    if (isSignedIn) navigate("/app");
  });
</script>

<svelte:head>
  <title>Sign in — Zane</title>
</svelte:head>

<AuthPageLayout>
  <span class="eyebrow">Sign in</span>
  <h1>Sign in</h1>
  <p class="subtitle">{authMode === "basic" ? "Sign in with your username." : "Use your passkey to access Zane."}</p>

  {#if auth.error}
    <div class="auth-error">{auth.error}</div>
  {/if}

  <input
    type="text"
    class="auth-input"
    placeholder="Username"
    bind:value={username}
    onkeydown={(e) => {
      if (e.key === "Enter" && username.trim()) auth.signIn(username.trim());
    }}
  />
  <button
    class="primary-btn"
    type="button"
    onclick={() => auth.signIn(username.trim())}
    disabled={auth.busy || !username.trim()}
  >
    {auth.busy ? "Working..." : authMode === "basic" ? "Sign in" : "Sign in with passkey"}
  </button>
  <a class="link-btn" href="/register">Create new account</a>
</AuthPageLayout>

<style>
  .eyebrow {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--cli-text-muted);
  }

  h1 {
    margin: 0;
    font-size: clamp(2.4rem, 5vw, 3.8rem);
    line-height: 0.88;
    letter-spacing: -0.05em;
  }

  .subtitle {
    margin: 0;
    color: var(--cli-text-dim);
    font-size: var(--text-base);
    line-height: 1.5;
    max-width: 32ch;
  }

  .auth-input {
    padding: 0.6rem 0.74rem;
    border-radius: var(--radius-md);
    border: 1px solid var(--cli-border);
    background: var(--cli-bg);
    color: var(--cli-text);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    letter-spacing: 0.02em;
    text-transform: uppercase;
    outline: none;
  }

  .auth-input:focus {
    border-color: var(--cli-text-dim);
  }

  .auth-error {
    padding: 0.62rem 0.72rem;
    border-radius: var(--radius-md);
    background: var(--cli-error-bg);
    border: 1px solid color-mix(in srgb, var(--cli-error) 46%, transparent);
    color: var(--cli-error);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    letter-spacing: 0.01em;
  }

  .primary-btn {
    padding: 0.58rem 0.72rem;
    border-radius: var(--radius-md);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    line-height: 1;
    cursor: pointer;
    border: 1px solid var(--cli-border);
    background: var(--color-btn-primary-bg, var(--cli-prefix-agent));
    color: var(--color-btn-primary-text, var(--cli-bg));
  }

  .primary-btn:hover {
    opacity: 0.9;
  }

  .primary-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .link-btn {
    align-self: flex-start;
    color: var(--cli-text-dim);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.02em;
    text-decoration: none;
    border-bottom: 1px solid color-mix(in srgb, var(--cli-text-muted) 60%, transparent);
  }

  .link-btn:hover {
    color: var(--cli-text);
  }
</style>
