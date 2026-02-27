import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const STORE_KEY = "__codex_remote_config_store__";
const STORAGE_KEY = "codex_remote_config";

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalStateDescriptor = Object.getOwnPropertyDescriptor(globalThis, "$state");

let storage: Storage;

function createLocalStorageMock(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(String(key), String(value));
    },
  } as Storage;
}

function installGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

function restoreGlobal(name: string, descriptor?: PropertyDescriptor) {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
    return;
  }
  Reflect.deleteProperty(globalThis, name);
}

function clearStoreSingleton() {
  Reflect.deleteProperty(globalThis as Record<string, unknown>, STORE_KEY);
}

async function loadConfig(savedRaw?: string): Promise<{ url: string }> {
  clearStoreSingleton();
  if (savedRaw === undefined) {
    storage.removeItem(STORAGE_KEY);
  } else {
    storage.setItem(STORAGE_KEY, savedRaw);
  }
  const nonce = `${Date.now()}-${Math.random()}`;
  const module = await import(`./config.svelte.ts?config-test=${nonce}`);
  return module.config as { url: string };
}

beforeEach(() => {
  storage = createLocalStorageMock();
  installGlobal("localStorage", storage);
  installGlobal("$state", <T>(value: T) => value);
  clearStoreSingleton();
});

afterEach(() => {
  clearStoreSingleton();
  restoreGlobal("localStorage", originalLocalStorageDescriptor);
  restoreGlobal("$state", originalStateDescriptor);
});

describe("config store", () => {
  test("loads persisted URL and trims whitespace", async () => {
    const config = await loadConfig(JSON.stringify({ url: "  wss://example.com/ws/client  " }));
    expect(config.url).toBe("wss://example.com/ws/client");
  });

  test("restores saved empty URL instead of falling back to default", async () => {
    const defaultUrl = (await loadConfig()).url;
    const config = await loadConfig(JSON.stringify({ url: "" }));
    expect(config.url).toBe("");
    if (defaultUrl) {
      expect(config.url).not.toBe(defaultUrl);
    }
  });

  test("ignores malformed saved JSON", async () => {
    const defaultUrl = (await loadConfig()).url;
    const config = await loadConfig("{not-json");
    expect(config.url).toBe(defaultUrl);
  });

  test("ignores non-string saved URL payloads", async () => {
    const defaultUrl = (await loadConfig()).url;
    const config = await loadConfig(JSON.stringify({ url: 123 }));
    expect(config.url).toBe(defaultUrl);
  });

  test("normalizes URL before saving", async () => {
    const config = await loadConfig();
    config.url = "  ws://localhost:8788/ws  ";
    expect(config.url).toBe("ws://localhost:8788/ws");
    expect(storage.getItem(STORAGE_KEY)).toBe(JSON.stringify({ url: "ws://localhost:8788/ws" }));
  });
});
