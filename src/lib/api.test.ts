import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const AUTH_STORE_KEY = "__codex_remote_auth_store__";
const CONFIG_STORE_KEY = "__codex_remote_config_store__";

type AuthStoreStub = {
  token: string | null;
  tryRefresh: () => Promise<boolean>;
};

type ConfigStoreStub = {
  url: string;
};

const globalStore = globalThis as Record<string, unknown>;

const authStub: AuthStoreStub = {
  token: "token-1",
  tryRefresh: async () => false,
};

const configStub: ConfigStoreStub = {
  url: "wss://example.test/ws/client",
};

const originalFetch = globalThis.fetch;
const originalAuthStore = globalStore[AUTH_STORE_KEY];
const originalConfigStore = globalStore[CONFIG_STORE_KEY];

let api: typeof import("./api").api;
let ApiError: typeof import("./api").ApiError;

beforeAll(async () => {
  globalStore[AUTH_STORE_KEY] = authStub;
  globalStore[CONFIG_STORE_KEY] = configStub;

  const imported = await import("./api");
  api = imported.api;
  ApiError = imported.ApiError;
});

beforeEach(() => {
  authStub.token = "token-1";
  authStub.tryRefresh = async () => false;
  configStub.url = "wss://example.test/ws/client";
});

afterAll(() => {
  globalThis.fetch = originalFetch;

  if (originalAuthStore === undefined) {
    delete globalStore[AUTH_STORE_KEY];
  } else {
    globalStore[AUTH_STORE_KEY] = originalAuthStore;
  }

  if (originalConfigStore === undefined) {
    delete globalStore[CONFIG_STORE_KEY];
  } else {
    globalStore[CONFIG_STORE_KEY] = originalConfigStore;
  }
});

describe("api request refresh handling", () => {
  test("returns original 401 ApiError when refresh throws", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("expired token", { status: 401, statusText: "Unauthorized" });
    }) as typeof fetch;

    authStub.tryRefresh = async () => {
      throw new Error("refresh crashed");
    };

    await expect(api.get("/secure")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      message: "expired token",
    });
    expect(fetchCalls).toBe(1);
  });

  test("retries request once when refresh succeeds", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Response("expired token", { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    authStub.tryRefresh = async () => true;

    await expect(api.get<{ ok: boolean }>("/secure")).resolves.toEqual({ ok: true });
    expect(fetchCalls).toBe(2);
  });

  test("throws ApiError when API URL is not configured", async () => {
    configStub.url = "";

    await expect(api.get("/secure")).rejects.toBeInstanceOf(ApiError);
    await expect(api.get("/secure")).rejects.toMatchObject({
      status: 0,
      message: "No API URL configured",
    });
  });
});
