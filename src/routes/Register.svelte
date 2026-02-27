<script lang="ts">
  import QRCode from "qrcode";
  import { auth } from "../lib/auth.svelte";
  import { navigate } from "../router";
  import AuthPageLayout from "../lib/components/AuthPageLayout.svelte";

  const authMode = (import.meta.env.AUTH_MODE ?? "passkey").toLowerCase();
  const allowTotp = authMode !== "basic";
  let newUsername = $state("");
  let totpCode = $state("");
  let method = $state<"passkey" | "totp">("passkey");
  let qrDataUrl = $state("");
  let registrationStarted = $state(false);
  const isSignedIn = $derived(auth.status === "signed_in");

  $effect(() => {
    if (isSignedIn) navigate(registrationStarted ? "/device" : "/app");
  });

  async function handleRegister() {
    const username = newUsername.trim();
    if (!username) return;
    registrationStarted = true;
    if (method === "totp") {
      if (!auth.totpSetup) {
        const started = await auth.startTotpRegistration(username);
        if (started && auth.totpSetup?.otpauthUrl) {
          try {
            qrDataUrl = await QRCode.toDataURL(auth.totpSetup.otpauthUrl, {
              width: 220,
              margin: 1,
            });
          } catch {
            qrDataUrl = "";
          }
        }
        return;
      }
      await auth.completeTotpRegistration(totpCode);
      return;
    }
    await auth.register(username);
  }

  function switchMethod(next: "passkey" | "totp") {
    if (method === next) return;
    method = next;
    auth.cancelTotpRegistration();
    totpCode = "";
    qrDataUrl = "";
  }
</script>

<svelte:head>
  <title>Create account — Codex Remote</title>
</svelte:head>

<AuthPageLayout>
  <span class="eyebrow">Register</span>
  <h1>Create account</h1>
  <p class="subtitle">
    {#if authMode === "basic"}
      Create a username for this control-plane.
    {:else if method === "totp"}
      Scan QR in your authenticator app, then confirm with a code.
    {:else}
      Register a new account with a passkey.
    {/if}
  </p>

  {#if allowTotp}
    <div class="method-toggle">
      <button type="button" class:active={method === "passkey"} onclick={() => switchMethod("passkey")}>Passkey</button>
      <button type="button" class:active={method === "totp"} onclick={() => switchMethod("totp")}>TOTP</button>
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
    disabled={auth.busy || (method === "totp" && Boolean(auth.totpSetup))}
    bind:value={newUsername}
    onkeydown={(e) => {
      if (e.key === "Enter" && newUsername.trim()) handleRegister();
    }}
  />
  {#if method === "totp" && auth.totpSetup}
    <div class="totp-setup">
      {#if qrDataUrl}
        <img src={qrDataUrl} alt="TOTP QR code" class="totp-qr" />
      {/if}
      <code class="totp-secret">{auth.totpSetup.secret}</code>
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
          if (e.key === "Enter" && totpCode.trim()) handleRegister();
        }}
      />
      <button
        class="ghost-btn"
        type="button"
        onclick={() => {
          auth.cancelTotpRegistration();
          totpCode = "";
          qrDataUrl = "";
        }}
        disabled={auth.busy}
      >
        Restart setup
      </button>
    </div>
  {/if}
  <button
    class="primary-btn"
    type="button"
    onclick={handleRegister}
    disabled={auth.busy || !newUsername.trim() || (method === "totp" && auth.totpSetup !== null && !totpCode.trim())}
  >
    {#if auth.busy}
      Working...
    {:else if authMode === "basic"}
      Create account
    {:else if method === "totp"}
      {auth.totpSetup ? "Verify code" : "Setup TOTP"}
    {:else}
      Create passkey
    {/if}
  </button>
  <a class="link-btn" href="/login">Back to sign in</a>
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

  .totp-setup {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .totp-qr {
    width: 220px;
    height: 220px;
    border-radius: var(--radius-md);
    border: 1px solid var(--cli-border);
    background: white;
  }

  .totp-secret {
    padding: 0.42rem 0.56rem;
    border-radius: var(--radius-md);
    border: 1px dashed var(--cli-border);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    user-select: all;
    word-break: break-all;
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

  .ghost-btn {
    align-self: flex-start;
    padding: 0.46rem 0.64rem;
    border-radius: var(--radius-md);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    text-transform: uppercase;
    border: 1px solid var(--cli-border);
    background: transparent;
    color: var(--cli-text);
    cursor: pointer;
  }

  .ghost-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
