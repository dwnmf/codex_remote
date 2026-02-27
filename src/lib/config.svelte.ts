const STORE_KEY = "__codex_remote_config_store__";
const STORAGE_KEY = "codex_remote_config";

const AUTH_URL = (import.meta.env.AUTH_URL ?? "").replace(/\/$/, "");

function buildDefaultWsUrl(authUrl: string): string {
  if (!authUrl) return "";
  try {
    const parsed = new URL(authUrl);
    parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    parsed.pathname = "/ws/client";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

const DEFAULT_WS_URL = buildDefaultWsUrl(AUTH_URL);

interface SavedConfig {
  url: string;
}

function normalizeUrlValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim();
}

class ConfigStore {
  #url = $state(DEFAULT_WS_URL);

  constructor() {
    this.#load();
  }

  get url() {
    return this.#url;
  }
  set url(value: string) {
    const normalized = normalizeUrlValue(value);
    if (normalized === null || normalized === this.#url) return;
    this.#url = normalized;
    this.#save();
  }

  #load() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;
      const parsed: unknown = JSON.parse(saved);
      if (!parsed || typeof parsed !== "object") return;
      const savedUrl = normalizeUrlValue((parsed as { url?: unknown }).url);
      if (savedUrl !== null) {
        this.#url = savedUrl;
      }
    } catch {
      // ignore
    }
  }

  #save() {
    try {
      const normalized = normalizeUrlValue(this.#url) ?? "";
      const data: SavedConfig = {
        url: normalized,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // ignore
    }
  }
}

function getStore(): ConfigStore {
  const global = globalThis as Record<string, unknown>;
  if (!global[STORE_KEY]) {
    global[STORE_KEY] = new ConfigStore();
  }
  return global[STORE_KEY] as ConfigStore;
}

export const config = getStore();
