import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const STORE_KEY = "__codex_remote_notifications_store__";
const PREFS_KEY = "codex_remote_notifications_prefs";

const globalEnv = globalThis as unknown as Record<string, unknown>;

const baseline = {
  hasNavigator: Object.prototype.hasOwnProperty.call(globalEnv, "navigator"),
  navigator: globalEnv.navigator,
  hasWindow: Object.prototype.hasOwnProperty.call(globalEnv, "window"),
  window: globalEnv.window,
  hasLocalStorage: Object.prototype.hasOwnProperty.call(globalEnv, "localStorage"),
  localStorage: globalEnv.localStorage,
  hasState: Object.prototype.hasOwnProperty.call(globalEnv, "$state"),
  state: globalEnv.$state,
};

function restoreGlobal(key: string, exists: boolean, value: unknown) {
  if (exists) {
    globalEnv[key] = value;
    return;
  }
  delete globalEnv[key];
}

function createLocalStorage(seed?: Record<string, string>) {
  const data = new Map<string, string>(Object.entries(seed ?? {}));
  const setCalls: Array<[string, string]> = [];

  const api = {
    getItem(key: string): string | null {
      return data.has(key) ? data.get(key)! : null;
    },
    setItem(key: string, value: string) {
      setCalls.push([key, value]);
      data.set(key, value);
    },
    removeItem(key: string) {
      data.delete(key);
    },
    clear() {
      data.clear();
    },
    key(index: number): string | null {
      const keys = Array.from(data.keys());
      return keys[index] ?? null;
    },
    get length() {
      return data.size;
    },
  };

  return { api, data, setCalls };
}

async function loadNotifications() {
  delete globalEnv[STORE_KEY];
  const mod = await import(`./notifications.svelte.ts?test=${Date.now()}-${Math.random()}`);
  return mod.notifications;
}

async function flushMicrotasks(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  globalEnv.$state = <T>(value: T) => value;
  delete globalEnv[STORE_KEY];
});

afterEach(() => {
  delete globalEnv[STORE_KEY];
  restoreGlobal("navigator", baseline.hasNavigator, baseline.navigator);
  restoreGlobal("window", baseline.hasWindow, baseline.window);
  restoreGlobal("localStorage", baseline.hasLocalStorage, baseline.localStorage);
  restoreGlobal("$state", baseline.hasState, baseline.state);
});

describe("notifications", () => {
  test("pushAvailable is safely false without browser globals", async () => {
    delete globalEnv.window;
    delete globalEnv.navigator;
    delete globalEnv.localStorage;

    const notifications = await loadNotifications();
    expect(notifications.pushAvailable).toBe(false);
  });

  test("clears persisted pushEnabled when service worker is unavailable", async () => {
    const storage = createLocalStorage({
      [PREFS_KEY]: JSON.stringify({ pushEnabled: true }),
    });

    globalEnv.localStorage = storage.api;
    globalEnv.navigator = {};

    const notifications = await loadNotifications();
    expect(notifications.pushSubscribed).toBe(false);
    expect(storage.data.get(PREFS_KEY)).toBe(JSON.stringify({ pushEnabled: false }));
  });

  test("clears persisted pushEnabled when subscription lookup fails", async () => {
    const storage = createLocalStorage({
      [PREFS_KEY]: JSON.stringify({ pushEnabled: true }),
    });

    globalEnv.localStorage = storage.api;
    globalEnv.navigator = {
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: async () => {
              throw new Error("failed");
            },
          },
        }),
      },
    };

    const notifications = await loadNotifications();
    await flushMicrotasks();

    expect(notifications.pushSubscribed).toBe(false);
    expect(storage.data.get(PREFS_KEY)).toBe(JSON.stringify({ pushEnabled: false }));
  });
});
