<script lang="ts">
  import { auth } from "../lib/auth.svelte";
  import { navigate } from "../router";
  import AuthPageLayout from "../lib/components/AuthPageLayout.svelte";

  const authMode = (import.meta.env.AUTH_MODE ?? "passkey").toLowerCase();
  const allowTotp = authMode !== "basic";
  let username = $state("");
  let totpCode = $state("");
  let method = $state<"passkey" | "totp">("passkey");
  const isSignedIn = $derived(auth.status === "signed_in");

  $effect(() => {
    if (isSignedIn) navigate("/app");
  });

  async function handleSignIn() {
    if (!username.trim()) return;
    if (method === "totp") {
      await auth.signIn(username.trim(), "totp", totpCode);
      return;
    }
    await auth.signIn(username.trim(), "passkey");
  }
</script>

<svelte:head>
  <title>Sign in — Codex Remote</title>
</svelte:head>

<AuthPageLayout>
  <span class="eyebrow">Sign in</span>
  <h1>Sign in</h1>
  <p class="subtitle">
    {#if authMode === "basic"}
      Sign in with your username.
    {:else if method === "totp"}
      Sign in with your username and one-time code.
    {:else}
      Use your passkey to access Codex Remote.
    {/if}
  </p>

  {#if allowTotp}
    <div class="method-toggle">
      <button
        type="button"
        class:active={method === "passkey"}
        onclick={() => {
          method = "passkey";
          totpCode = "";
        }}
      >
        Passkey
      </button>
      <button
        type="button"
        class:active={method === "totp"}
        onclick={() => {
          method = "totp";
        }}
      >
        TOTP
      </button>
    </div>
  {/if}

  {#if auth.error}
    <div class="auth-error">{auth.error}</div>
  {/if}

  <input
    type="text"
    class="auth-input"
    placeholder="Username"
    autocomplete="username"
    autocapitalize="none"
    autocorrect="off"
    spellcheck="false"
    bind:value={username}
    onkeydown={(e) => {
      if (e.key === "Enter" && username.trim()) void handleSignIn();
    }}
  />
  {#if method === "totp" && authMode !== "basic"}
    <input
      type="text"
      class="auth-input"
      placeholder="123456"
      autocomplete="one-time-code"
      autocapitalize="none"
      autocorrect="off"
      spellcheck="false"
      inputmode="numeric"
      pattern="[0-9]*"
      bind:value={totpCode}
      onkeydown={(e) => {
        if (e.key === "Enter" && username.trim() && totpCode.trim()) void handleSignIn();
      }}
    />
  {/if}
  <button
    class="primary-btn"
    type="button"
    onclick={handleSignIn}
    disabled={auth.busy || !username.trim() || (method === "totp" && !totpCode.trim())}
  >
    {#if auth.busy}
      Working...
    {:else if authMode === "basic"}
      Sign in
    {:else if method === "totp"}
      Sign in with TOTP
    {:else}
      Sign in with passkey
    {/if}
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

  .method-toggle {
    display: flex;
    gap: 0.5rem;
  }

  .method-toggle button {
    border: 1px solid var(--cli-border);
    background: transparent;
    color: var(--cli-text-dim);
    border-radius: var(--radius-md);
    padding: 0.45rem 0.65rem;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    text-transform: uppercase;
    cursor: pointer;
  }

  .method-toggle button.active {
    color: var(--cli-bg);
    background: var(--cli-text);
    border-color: var(--cli-text);
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
