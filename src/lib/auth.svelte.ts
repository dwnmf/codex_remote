import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/types";

const STORE_KEY = "__codex_remote_auth_store__";
const STORAGE_KEY = "codex_remote_auth_token";
const REFRESH_STORAGE_KEY = "codex_remote_refresh_token";
const LOCAL_MODE_KEY = "codex_remote_local_mode";
const AUTH_BASE_URL = (import.meta.env.AUTH_URL ?? "").replace(/\/$/, "");
const AUTH_MODE = (import.meta.env.AUTH_MODE ?? "passkey").toLowerCase();

/**
 * Local mode is enabled when:
 * 1. No AUTH_URL is configured (no Orbit server to auth against), OR
 * 2. Explicitly enabled via localStorage
 *
 * This allows direct connection to Anchor without authentication,
 * perfect for trusted networks like Tailscale.
 */
function isLocalMode(): boolean {
  // Auto-detect: no AUTH_URL means no auth server available
  if (!AUTH_BASE_URL) return true;
  // Manual override via localStorage
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(LOCAL_MODE_KEY) === "1";
}

type AuthStatus = "loading" | "signed_out" | "signed_in" | "needs_setup";
export type AuthMethod = "passkey" | "totp";

interface AuthUser {
  id: string;
  name: string;
}

interface AuthSessionResponse {
  authenticated: boolean;
  user: AuthUser | null;
  hasPasskey: boolean;
  hasTotp?: boolean;
  systemHasUsers: boolean;
}

interface AuthVerifyResponse {
  verified: boolean;
  token: string;
  refreshToken?: string;
  user?: AuthUser;
}

interface RefreshResponse {
  token: string;
  refreshToken: string;
  user?: AuthUser;
  error?: string;
}

interface LoginOptionsResponse extends PublicKeyCredentialRequestOptionsJSON {
  error?: string;
}

interface RegisterOptionsResponse extends PublicKeyCredentialCreationOptionsJSON {
  error?: string;
}

interface BasicAuthResponse {
  token?: string;
  refreshToken?: string;
  user?: AuthUser;
  error?: string;
}

interface TotpSetupResponse {
  setupToken?: string;
  secret?: string;
  otpauthUrl?: string;
  issuer?: string;
  digits?: number;
  period?: number;
  error?: string;
}

interface TotpSetupState {
  setupToken: string;
  secret: string;
  otpauthUrl: string;
  issuer: string;
  digits: number;
  period: number;
  username: string;
}

function apiUrl(path: string): string {
  return `${AUTH_BASE_URL}${path}`;
}

async function parseResponse<T>(response: Response): Promise<T | null> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function base64UrlDecodeToString(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return atob(padded);
}

function decodeJwtPayload(token: string): { exp?: number } | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const json = base64UrlDecodeToString(parts[1]);
    return JSON.parse(json) as { exp?: number };
  } catch {
    return null;
  }
}

class AuthStore {
  status = $state<AuthStatus>("loading");
  hasPasskey = $state(false);
  hasTotp = $state(false);
  totpSetup = $state<TotpSetupState | null>(null);
  token = $state<string | null>(null);
  user = $state<AuthUser | null>(null);
  busy = $state(false);
  error = $state<string | null>(null);
  #refreshToken: string | null = null;
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;
  #refreshPromise: Promise<boolean> | null = null;

  constructor() {
    this.#loadToken();
    void this.initialize();
  }

  async initialize() {
    this.status = "loading";
    this.error = null;
    this.totpSetup = null;

    // Local mode: skip all auth for trusted networks (e.g., Tailscale)
    if (isLocalMode()) {
      this.status = "signed_in";
      this.user = { id: "local", name: "local" };
      this.token = "local-mode";
      return;
    }

    try {
      const response = await fetch(apiUrl("/auth/session"), {
        method: "GET",
        headers: this.#authHeaders(),
      });
      const data = await parseResponse<AuthSessionResponse>(response);

      if (!response.ok || !data) {
        this.error = "Auth backend unavailable.";
        this.status = "signed_out";
        return;
      }

      this.hasPasskey = data.hasPasskey;
      this.hasTotp = Boolean(data.hasTotp);

      if (data.authenticated && data.user) {
        this.user = data.user;
        this.status = "signed_in";
        this.#scheduleRefresh();
        return;
      }

      if (this.#refreshToken) {
        const refreshed = await this.tryRefresh();
        if (refreshed) {
          const retryResponse = await fetch(apiUrl("/auth/session"), {
            method: "GET",
            headers: this.#authHeaders(),
          });
          const retryData = await parseResponse<AuthSessionResponse>(retryResponse);
          if (retryResponse.ok && retryData?.authenticated && retryData.user) {
            this.hasPasskey = retryData.hasPasskey;
            this.hasTotp = Boolean(retryData.hasTotp);
            this.user = retryData.user;
            this.status = "signed_in";
            this.#scheduleRefresh();
            return;
          }

          this.status = "signed_in";
          this.#scheduleRefresh();
          return;
        }
      }

      this.token = null;
      this.#clearToken();
      this.status = data.systemHasUsers ? "signed_out" : "needs_setup";
    } catch {
      this.error = "Auth backend unavailable.";
      this.status = "signed_out";
    }
  }

  async signIn(username: string, method: AuthMethod = "passkey", totpCode = ""): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = null;

    try {
      if (AUTH_MODE === "basic") {
        const response = await fetch(apiUrl("/auth/login/basic"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username }),
        });
        const data = await parseResponse<BasicAuthResponse>(response);
        if (!response.ok || !data?.token) {
          this.error = data?.error ?? "Sign-in failed.";
          return;
        }

        this.#applySession({ verified: true, token: data.token, refreshToken: data.refreshToken, user: data.user });
        this.hasPasskey = false;
        return;
      }

      if (method === "totp") {
        const response = await fetch(apiUrl("/auth/login/totp"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username, code: totpCode }),
        });
        const data = await parseResponse<BasicAuthResponse>(response);
        if (!response.ok || !data?.token) {
          this.error = data?.error ?? "Sign-in failed.";
          return;
        }
        this.#applySession({ verified: true, token: data.token, refreshToken: data.refreshToken, user: data.user });
        this.hasTotp = true;
        return;
      }

      const optionsResponse = await fetch(apiUrl("/auth/login/options"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username }),
      });
      const options = await parseResponse<LoginOptionsResponse>(optionsResponse);
      if (!optionsResponse.ok || !options || options.error) {
        this.error = options?.error ?? "Unable to request sign-in.";
        return;
      }

      const credential = await startAuthentication({ optionsJSON: options });
      const verifyResponse = await fetch(apiUrl("/auth/login/verify"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential }),
      });
      const verify = await parseResponse<AuthVerifyResponse & { error?: string }>(verifyResponse);
      if (!verifyResponse.ok || !verify?.token) {
        this.error = verify?.error ?? "Sign-in failed.";
        return;
      }

      this.#applySession(verify);
      this.hasPasskey = true;
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Sign-in cancelled.";
    } finally {
      this.busy = false;
    }
  }

  async register(name: string, displayName?: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = null;

    try {
      if (AUTH_MODE === "basic") {
        const response = await fetch(apiUrl("/auth/register/basic"), {
          method: "POST",
          headers: { "content-type": "application/json", ...this.#authHeaders() },
          body: JSON.stringify({ name, displayName: displayName || name }),
        });
        const data = await parseResponse<BasicAuthResponse>(response);
        if (!response.ok || !data?.token) {
          this.error = data?.error ?? "Registration failed.";
          return;
        }

        this.#applySession({ verified: true, token: data.token, refreshToken: data.refreshToken, user: data.user });
        this.hasPasskey = false;
        return;
      }

      const optionsResponse = await fetch(apiUrl("/auth/register/options"), {
        method: "POST",
        headers: { "content-type": "application/json", ...this.#authHeaders() },
        body: JSON.stringify({ name, displayName: displayName || name }),
      });
      const options = await parseResponse<RegisterOptionsResponse>(optionsResponse);
      if (!optionsResponse.ok || !options || options.error) {
        this.error = options?.error ?? "Unable to start registration.";
        return;
      }

      const credential = await startRegistration({ optionsJSON: options });
      const verifyResponse = await fetch(apiUrl("/auth/register/verify"), {
        method: "POST",
        headers: { "content-type": "application/json", ...this.#authHeaders() },
        body: JSON.stringify({ credential }),
      });
      const verify = await parseResponse<AuthVerifyResponse & { error?: string }>(verifyResponse);
      if (!verifyResponse.ok || !verify?.token) {
        this.error = verify?.error ?? "Registration failed.";
        return;
      }

      this.#applySession(verify);
      this.hasPasskey = true;
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Registration cancelled.";
    } finally {
      this.busy = false;
    }
  }

  async startTotpRegistration(name: string, displayName?: string): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    this.error = null;

    try {
      const response = await fetch(apiUrl("/auth/register/totp/start"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, displayName: displayName || name }),
      });
      const data = await parseResponse<TotpSetupResponse>(response);
      if (!response.ok || !data?.setupToken || !data.secret || !data.otpauthUrl) {
        this.error = data?.error ?? "Unable to start TOTP setup.";
        this.totpSetup = null;
        return false;
      }

      this.totpSetup = {
        setupToken: data.setupToken,
        secret: data.secret,
        otpauthUrl: data.otpauthUrl,
        issuer: data.issuer ?? "Codex Remote",
        digits: data.digits ?? 6,
        period: data.period ?? 30,
        username: name,
      };
      return true;
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Unable to start TOTP setup.";
      this.totpSetup = null;
      return false;
    } finally {
      this.busy = false;
    }
  }

  async completeTotpRegistration(code: string): Promise<void> {
    if (this.busy) return;
    if (!this.totpSetup) {
      this.error = "TOTP setup is missing.";
      return;
    }

    this.busy = true;
    this.error = null;
    try {
      const response = await fetch(apiUrl("/auth/register/totp/verify"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setupToken: this.totpSetup.setupToken, code }),
      });
      const data = await parseResponse<BasicAuthResponse>(response);
      if (!response.ok || !data?.token) {
        this.error = data?.error ?? "Registration failed.";
        return;
      }

      this.#applySession({ verified: true, token: data.token, refreshToken: data.refreshToken, user: data.user });
      this.hasTotp = true;
      this.totpSetup = null;
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Registration failed.";
    } finally {
      this.busy = false;
    }
  }

  cancelTotpRegistration(): void {
    this.totpSetup = null;
  }

  async signOut(): Promise<void> {
    try {
      if (this.token) {
        await fetch(apiUrl("/auth/logout"), {
          method: "POST",
          headers: this.#authHeaders(),
        });
      }
    } catch {
      // ignore
    }
    this.token = null;
    this.user = null;
    this.hasPasskey = false;
    this.hasTotp = false;
    this.totpSetup = null;
    this.status = "signed_out";
    this.error = null;
    this.#clearToken();
  }

  /** Enable local mode for trusted networks (bypasses all auth) */
  enableLocalMode(): void {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LOCAL_MODE_KEY, "1");
    }
    this.status = "signed_in";
    this.user = { id: "local", name: "local" };
    this.token = "local-mode";
    this.totpSetup = null;
  }

  /** Disable local mode and return to normal auth flow */
  disableLocalMode(): void {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(LOCAL_MODE_KEY);
    }
    void this.initialize();
  }

  /** Check if local mode is active */
  get isLocalMode(): boolean {
    return isLocalMode();
  }

  #applySession(payload: AuthVerifyResponse): void {
    this.token = payload.token;
    this.#refreshToken = payload.refreshToken ?? null;
    this.user = payload.user ?? null;
    this.status = "signed_in";
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, payload.token);
      if (payload.refreshToken) {
        localStorage.setItem(REFRESH_STORAGE_KEY, payload.refreshToken);
      } else {
        localStorage.removeItem(REFRESH_STORAGE_KEY);
      }
    }
    this.#scheduleRefresh();
    void this.#syncSessionFlags();
  }

  #authHeaders(): HeadersInit {
    if (!this.token) return {};
    return { authorization: `Bearer ${this.token}` };
  }

  #loadToken(): void {
    if (typeof localStorage === "undefined") return;
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      this.token = stored;
    }
    const storedRefresh = localStorage.getItem(REFRESH_STORAGE_KEY);
    if (storedRefresh) {
      this.#refreshToken = storedRefresh;
    }
  }

  #clearToken(): void {
    if (this.#refreshTimer) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = null;
    }
    this.#refreshToken = null;
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(REFRESH_STORAGE_KEY);
  }

  #scheduleRefresh(): void {
    if (this.#refreshTimer) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = null;
    }
    if (!this.token) return;

    // Parse JWT exp to schedule refresh 60s before expiry
    try {
      const payload = decodeJwtPayload(this.token);
      if (!payload?.exp) return;
      const msUntilExpiry = payload.exp * 1000 - Date.now();
      const refreshIn = Math.max(msUntilExpiry - 60_000, 0);
      this.#refreshTimer = setTimeout(() => void this.tryRefresh(), refreshIn);
    } catch {
      // malformed token, skip scheduling
    }
  }

  async tryRefresh(): Promise<boolean> {
    if (this.#refreshPromise) return this.#refreshPromise;
    this.#refreshPromise = this.#doRefresh();
    try {
      return await this.#refreshPromise;
    } finally {
      this.#refreshPromise = null;
    }
  }

  async #doRefresh(): Promise<boolean> {
    if (!this.#refreshToken) return false;

    try {
      const response = await fetch(apiUrl("/auth/refresh"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: this.#refreshToken }),
      });
      const data = await parseResponse<RefreshResponse>(response);
      if (!response.ok || !data?.token) {
        // Only sign out on explicit rejection (401). Transient errors (500, 502)
        // should not clear the session — the current JWT may still be valid.
        if (response.status === 401) {
          this.token = null;
          this.user = null;
          this.status = "signed_out";
          this.#clearToken();
        }
        return false;
      }

      this.token = data.token;
      this.#refreshToken = data.refreshToken;
      if (data.user) {
        this.user = data.user;
      }
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(STORAGE_KEY, data.token);
        localStorage.setItem(REFRESH_STORAGE_KEY, data.refreshToken);
      }
      this.#scheduleRefresh();
      void this.#syncSessionFlags();
      return true;
    } catch {
      return false;
    }
  }

  async #syncSessionFlags(): Promise<void> {
    try {
      const response = await fetch(apiUrl("/auth/session"), {
        method: "GET",
        headers: this.#authHeaders(),
      });
      const data = await parseResponse<AuthSessionResponse>(response);
      if (!response.ok || !data) return;
      this.hasPasskey = data.hasPasskey;
      this.hasTotp = Boolean(data.hasTotp);
    } catch {
      // ignore best-effort update
    }
  }
}

function getStore(): AuthStore {
  const global = globalThis as Record<string, unknown>;
  if (!global[STORE_KEY]) {
    global[STORE_KEY] = new AuthStore();
  }
  return global[STORE_KEY] as AuthStore;
}

export const auth = getStore();
