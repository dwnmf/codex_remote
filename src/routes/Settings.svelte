<script lang="ts">
  import { auth } from "../lib/auth.svelte";
  import { theme } from "../lib/theme.svelte";
  import { config } from "../lib/config.svelte";
  import { connectionManager } from "../lib/connection-manager.svelte";
  import { socket } from "../lib/socket.svelte";
  import AppHeader from "../lib/components/AppHeader.svelte";
  import NotificationSettings from "../lib/components/NotificationSettings.svelte";
  import { anchors } from "../lib/anchors.svelte";

  const themeIcons = { system: "◐", light: "○", dark: "●" } as const;

  const anchorList = $derived(anchors.list);
  const selectedAnchorId = $derived(anchors.selectedId);

  const platformLabels: Record<string, string> = {
    darwin: "macOS",
    linux: "Linux",
    win32: "Windows",
  };

  const urlLocked = $derived(
    socket.status === "connected" || socket.status === "connecting" || socket.status === "reconnecting"
  );
  const canDisconnect = $derived(
    socket.status === "connected" || socket.status === "connecting" || socket.status === "reconnecting"
  );
  const canConnect = $derived(socket.status === "disconnected" || socket.status === "error");
  const isSocketConnected = $derived(socket.status === "connected");
  const canManageCodexConfig = $derived(auth.isLocalMode || Boolean(selectedAnchorId));
  const connectionActionLabel = $derived.by(() => {
    if (socket.status === "connecting") return "Cancel";
    if (socket.status === "reconnecting") return "Stop reconnect";
    if (socket.status === "connected") return "Disconnect";
    return "Connect";
  });

  let codexConfigPath = $state("");
  let codexConfigCandidates = $state<string[]>([]);
  let codexConfigPlatform = $state("");
  let codexConfigExists = $state(false);
  let codexConfigContent = $state("");
  let codexConfigLoading = $state(false);
  let codexConfigSaving = $state(false);
  let codexConfigDirty = $state(false);
  let codexConfigError = $state<string | null>(null);
  let codexConfigInfo = $state<string | null>(null);
  let codexConfigLoadedFor = $state<string | null>(null);

  function formatSince(iso: string): string {
    const date = new Date(iso);
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function handleSelectAnchor(anchorId: string) {
    anchors.select(anchorId);
  }

  function resolveConfigTargetKey(): string {
    if (auth.isLocalMode) return "local";
    if (!selectedAnchorId) return "anchor:none";
    return `anchor:${selectedAnchorId}`;
  }

  function resolveAnchorIdForConfig(): string | undefined {
    if (auth.isLocalMode) return undefined;
    const candidate = selectedAnchorId?.trim();
    return candidate ? candidate : undefined;
  }

  async function loadCodexConfig(path?: string, force = false) {
    if (!isSocketConnected) {
      codexConfigError = "Connect first to load config.toml.";
      return;
    }
    if (!canManageCodexConfig) {
      codexConfigError = "Select a device to load config.toml.";
      return;
    }
    if (codexConfigDirty && !force && !path) {
      codexConfigInfo = "Unsaved changes detected. Save or reload to discard.";
      return;
    }

    codexConfigLoading = true;
    codexConfigError = null;
    codexConfigInfo = null;
    try {
      const result = await socket.readCodexConfig(path, resolveAnchorIdForConfig());
      codexConfigPath = result.path;
      codexConfigCandidates = result.candidates;
      codexConfigPlatform = platformLabels[result.platform] ?? result.platform;
      codexConfigExists = result.exists;
      codexConfigContent = result.content;
      codexConfigDirty = false;
      codexConfigLoadedFor = resolveConfigTargetKey();
      codexConfigInfo = result.exists
        ? `Loaded ${result.path}`
        : `config.toml not found. It will be created at ${result.path} when you save.`;
    } catch (err) {
      codexConfigError = err instanceof Error ? err.message : "Failed to load config.toml";
    } finally {
      codexConfigLoading = false;
    }
  }

  async function saveCodexConfig() {
    if (!isSocketConnected) {
      codexConfigError = "Connect first to save config.toml.";
      return;
    }
    if (!canManageCodexConfig) {
      codexConfigError = "Select a device to save config.toml.";
      return;
    }
    if (!codexConfigPath.trim()) {
      codexConfigError = "config.toml path is empty.";
      return;
    }

    codexConfigSaving = true;
    codexConfigError = null;
    codexConfigInfo = null;
    try {
      const result = await socket.writeCodexConfig(codexConfigContent, codexConfigPath, resolveAnchorIdForConfig());
      codexConfigPath = result.path;
      if (!codexConfigCandidates.includes(result.path)) {
        codexConfigCandidates = [result.path, ...codexConfigCandidates];
      }
      codexConfigExists = true;
      codexConfigDirty = false;
      codexConfigLoadedFor = resolveConfigTargetKey();
      codexConfigInfo = `Saved ${result.path}`;
    } catch (err) {
      codexConfigError = err instanceof Error ? err.message : "Failed to save config.toml";
    } finally {
      codexConfigSaving = false;
    }
  }

  function handleConfigContentInput(value: string) {
    codexConfigContent = value;
    codexConfigDirty = true;
    codexConfigInfo = null;
  }

  function handleConfigPathSelect(path: string) {
    if (!path || path === codexConfigPath) return;
    void loadCodexConfig(path, true);
  }

  $effect(() => {
    if (!isSocketConnected) return;
    if (!canManageCodexConfig) return;
    const targetKey = resolveConfigTargetKey();
    if (codexConfigLoadedFor === targetKey) return;
    if (codexConfigDirty) return;
    void loadCodexConfig(undefined, true);
  });

</script>

<div class="settings stack">
  <AppHeader status={socket.status}>
    {#snippet actions()}
      <button type="button" onclick={() => theme.cycle()} title="Theme: {theme.current}">
        {themeIcons[theme.current]}
      </button>
    {/snippet}
  </AppHeader>

  <div class="content stack">
    <section class="settings-masthead stack">
      <span class="settings-kicker">Control plane</span>
      <h1>SETTINGS</h1>
      <p>Manage connection, devices, notifications, and account-level actions.</p>
    </section>

    <div class="section stack">
      <div class="section-header">
        <span class="section-index">01</span>
        <span class="section-title">Connection</span>
      </div>
      <div class="section-body stack">
        <div class="field stack">
          <label for="orbit-url">{auth.isLocalMode ? "Anchor URL" : "Orbit URL"}</label>
          <input
            id="orbit-url"
            type="text"
            bind:value={config.url}
            placeholder={auth.isLocalMode ? "ws://<anchor-ip>:8788/ws" : "wss://orbit.example.com/ws/client"}
            disabled={urlLocked}
          />
        </div>
        <div class="connect-actions row">
          <button
            class="action-btn"
            type="button"
            onclick={() => {
              if (canDisconnect) {
                connectionManager.requestDisconnect();
              } else if (canConnect) {
                connectionManager.requestConnect();
              }
            }}
            disabled={!canDisconnect && !canConnect}
          >
            {connectionActionLabel}
          </button>
        </div>
        {#if socket.error}
          <p class="hint hint-error">{socket.error}</p>
        {/if}
        <p class="hint">
          {socket.status === "disconnected"
            ? "Auto-connect paused. Click Connect to resume."
            : "Connection is automatic on app load. Disconnect to pause and to change the URL."}
        </p>
        {#if auth.isLocalMode}
          <p class="hint hint-local">
            Local mode: Connect directly to Anchor on your network (e.g., via Tailscale). No Orbit authentication required.
          </p>
        {/if}
      </div>
    </div>

    <div class="section stack">
      <div class="section-header">
        <span class="section-index">02</span>
        <span class="section-title">Devices</span>
      </div>
      <div class="section-body stack">
        {#if !isSocketConnected}
          <p class="hint">
            Connect to load devices.
          </p>
        {:else if anchorList.length === 0}
          <p class="hint">
            No devices connected. Run <code>codex-remote start</code> in your terminal — a code will appear, then enter it at <a href="/device">/device</a> to authorise.
          </p>
        {:else}
          <ul class="anchor-list">
            {#each anchorList as anchor (anchor.id)}
              <li class="anchor-item">
                <button
                  type="button"
                  class="anchor-select"
                  class:selected={selectedAnchorId === anchor.id}
                  onclick={() => handleSelectAnchor(anchor.id)}
                  aria-pressed={selectedAnchorId === anchor.id}
                >
                  <span class="anchor-status" title="Connected">●</span>
                </button>
                <div class="anchor-info">
                  <span class="anchor-hostname">{anchor.hostname}</span>
                  <span class="anchor-meta">{platformLabels[anchor.platform] ?? anchor.platform} · since {formatSince(anchor.connectedAt)}</span>
                </div>
                {#if selectedAnchorId === anchor.id}
                  <span class="anchor-selected-label">Selected</span>
                {/if}
              </li>
            {/each}
          </ul>
          {#if !selectedAnchorId}
            <p class="hint hint-error">Select a device. New sessions will start only on the selected device.</p>
          {/if}
        {/if}
      </div>
    </div>

    <div class="section stack">
      <div class="section-header">
        <span class="section-index">03</span>
        <span class="section-title">Codex Config</span>
      </div>
      <div class="section-body stack">
        {#if !isSocketConnected}
          <p class="hint">Connect first to read and edit <code>config.toml</code>.</p>
        {:else if !canManageCodexConfig}
          <p class="hint">Select a device to edit <code>config.toml</code> on that machine.</p>
        {:else}
          <div class="field stack">
            <label for="codex-config-path">config.toml path</label>
            {#if codexConfigCandidates.length > 1}
              <select
                id="codex-config-path"
                value={codexConfigPath}
                onchange={(e) => handleConfigPathSelect((e.currentTarget as HTMLSelectElement).value)}
                disabled={codexConfigLoading || codexConfigSaving}
              >
                {#each codexConfigCandidates as path}
                  <option value={path}>{path}</option>
                {/each}
              </select>
            {:else}
              <input
                id="codex-config-path"
                type="text"
                value={codexConfigPath}
                readonly
                disabled
              />
            {/if}
          </div>

          {#if codexConfigPlatform}
            <p class="hint">Detected OS: {codexConfigPlatform}</p>
          {/if}
          <p class="hint">
            {codexConfigExists
              ? "Editing existing file."
              : "File does not exist yet; Save will create it."}
          </p>

          <div class="field stack">
            <label for="codex-config-content">Contents</label>
            <textarea
              id="codex-config-content"
              class="config-editor"
              value={codexConfigContent}
              oninput={(e) => handleConfigContentInput((e.currentTarget as HTMLTextAreaElement).value)}
              placeholder={'model = "o3"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"'}
              spellcheck="false"
              disabled={codexConfigLoading || codexConfigSaving}
            ></textarea>
          </div>

          <div class="connect-actions row">
            <button
              class="action-btn"
              type="button"
              onclick={() => loadCodexConfig(undefined, true)}
              disabled={codexConfigLoading || codexConfigSaving}
            >
              {codexConfigLoading ? "Loading..." : "Reload"}
            </button>
            <button
              class="action-btn"
              type="button"
              onclick={saveCodexConfig}
              disabled={codexConfigLoading || codexConfigSaving || !codexConfigPath || !codexConfigDirty}
            >
              {codexConfigSaving ? "Saving..." : "Save"}
            </button>
          </div>
          {#if codexConfigDirty}
            <p class="hint">Unsaved changes.</p>
          {/if}
          {#if codexConfigInfo}
            <p class="hint hint-local">{codexConfigInfo}</p>
          {/if}
          {#if codexConfigError}
            <p class="hint hint-error">{codexConfigError}</p>
          {/if}
        {/if}
      </div>
    </div>

    <NotificationSettings />

    {#if !auth.isLocalMode}
      <div class="section stack">
        <div class="section-header">
          <span class="section-index">05</span>
          <span class="section-title">Account</span>
        </div>
        <div class="section-body stack">
          <button class="action-btn danger" type="button" onclick={() => auth.signOut()}>Sign out</button>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .settings {
    --stack-gap: 0;
    min-height: 100vh;
    background: var(--cli-bg);
    color: var(--cli-text);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }

  .content {
    --stack-gap: var(--space-lg);
    padding: var(--space-md) var(--space-md) var(--space-xl);
    max-width: min(1480px, calc(100vw - var(--space-md) * 2));
    margin: 0 auto;
    width: 100%;
  }

  .settings-masthead {
    --stack-gap: 0.3rem;
    padding: 0.3rem 0 0.6rem;
  }

  .settings-kicker {
    font-family: var(--font-mono);
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--cli-text-muted);
  }

  h1 {
    margin: 0;
    font-family: var(--font-display);
    font-size: clamp(3rem, 9vw, 6.8rem);
    line-height: 0.82;
    letter-spacing: -0.015em;
    text-transform: uppercase;
  }

  .settings-masthead p {
    margin: 0;
    max-width: 56ch;
    color: var(--cli-text-dim);
    font-family: var(--font-editorial);
    font-size: 1rem;
    line-height: 1.45;
  }

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

  .field select {
    padding: 0.55rem 0.62rem;
    background: var(--cli-bg);
    border: 1px solid var(--cli-border);
    border-radius: var(--radius-md);
    color: var(--cli-text);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
  }

  .field input:focus,
  .field select:focus {
    outline: none;
    border-color: var(--cli-prefix-agent);
  }

  .field input:disabled,
  .field select:disabled {
    opacity: 0.6;
    background: var(--cli-bg-elevated);
  }

  .config-editor {
    min-height: 13rem;
    width: 100%;
    padding: 0.62rem 0.68rem;
    background: var(--cli-bg);
    border: 1px solid var(--cli-border);
    border-radius: var(--radius-md);
    color: var(--cli-text);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.45;
    resize: vertical;
  }

  .config-editor:focus {
    outline: none;
    border-color: var(--cli-prefix-agent);
  }

  .config-editor:disabled {
    opacity: 0.6;
    background: var(--cli-bg-elevated);
  }

  .connect-actions {
    align-items: center;
    gap: var(--space-sm);
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

  .action-btn.danger {
    color: var(--cli-error);
    border-color: color-mix(in srgb, var(--cli-error) 42%, var(--cli-border));
  }

  .action-btn.danger:hover {
    background: var(--cli-error-bg);
    border-color: var(--cli-error);
  }

  .anchor-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }

  .anchor-item {
    display: flex;
    align-items: flex-start;
    gap: var(--space-sm);
    padding: var(--space-xs) 0;
  }

  .anchor-select {
    border: 1px solid var(--cli-border);
    background: transparent;
    border-radius: 999px;
    width: 1.2rem;
    height: 1.2rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    cursor: pointer;
  }

  .anchor-select.selected {
    border-color: var(--cli-prefix-agent);
    background: color-mix(in srgb, var(--cli-prefix-agent) 22%, transparent);
  }

  .anchor-status {
    font-size: var(--text-xs);
    color: var(--cli-success, #4ade80);
    margin-top: 1px;
  }

  .anchor-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .anchor-hostname {
    color: var(--cli-text);
    font-weight: 500;
  }

  .anchor-meta {
    color: var(--cli-text-muted);
    font-size: var(--text-xs);
  }

  .anchor-selected-label {
    margin-left: auto;
    color: var(--cli-prefix-agent);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding-top: 2px;
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

  .hint a {
    color: var(--cli-prefix-agent);
  }
</style>
