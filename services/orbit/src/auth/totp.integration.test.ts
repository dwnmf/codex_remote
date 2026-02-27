import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AuthEnv } from "./env";
import { generateTotpCode } from "./totp";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
}));

const { handleAuthRequest } = await import("./index");

class TestPreparedStatement {
  constructor(
    private readonly sqlite: Database,
    private readonly query: string,
    private readonly params: unknown[] = []
  ) {}

  bind(...values: unknown[]): TestPreparedStatement {
    return new TestPreparedStatement(this.sqlite, this.query, values);
  }

  async first<T>(): Promise<T | null> {
    const row = this.sqlite.query(this.query).get(...this.params) as T | undefined;
    return row ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const rows = this.sqlite.query(this.query).all(...this.params) as T[];
    return { results: rows };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const result = this.sqlite.query(this.query).run(...this.params) as { changes?: number };
    return { success: true, meta: { changes: result.changes ?? 0 } };
  }
}

function loadSql(relativePath: string): string {
  return readFileSync(join(import.meta.dir, relativePath), "utf8");
}

function createTestEnv(): AuthEnv {
  const sqlite = new Database(":memory:");
  sqlite.exec(loadSql("../../../../migrations/001_create_tables.sql"));
  sqlite.exec(loadSql("../../../../migrations/002_totp_factors.sql"));

  const db = {
    prepare: (query: string) => new TestPreparedStatement(sqlite, query),
  } as unknown as D1Database;

  const challengeNamespace = {
    idFromName: (_name: string) => ({}),
    get: (_id: unknown) => ({
      fetch: async () => new Response("not used", { status: 500 }),
    }),
  } as unknown as DurableObjectNamespace;

  return {
    DB: db,
    PASSKEY_CHALLENGE_DO: challengeNamespace,
    PASSKEY_ORIGIN: "https://app.test",
    CODEX_REMOTE_WEB_JWT_SECRET: "test-web-secret",
    CODEX_REMOTE_ANCHOR_JWT_SECRET: "test-anchor-secret",
  };
}

async function callAuth(
  env: AuthEnv,
  path: string,
  init: { method: string; payload?: unknown; token?: string }
): Promise<Response> {
  const headers = new Headers();
  headers.set("origin", "https://app.test");
  if (init.payload !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (init.token) {
    headers.set("authorization", `Bearer ${init.token}`);
  }
  const request = new Request(`https://orbit.test${path}`, {
    method: init.method,
    headers,
    body: init.payload !== undefined ? JSON.stringify(init.payload) : undefined,
  });
  const response = await handleAuthRequest(request, env);
  if (!response) {
    throw new Error("Expected auth response");
  }
  return response;
}

async function withNow<T>(nowMs: number, fn: () => Promise<T>): Promise<T> {
  const originalNow = Date.now;
  Date.now = () => nowMs;
  try {
    return await fn();
  } finally {
    Date.now = originalNow;
  }
}

describe("totp integration", () => {
  test("registers with TOTP, then signs in and returns session flags", async () => {
    const env = createTestEnv();
    const t0 = Math.floor(Date.now() / 30_000) * 30_000;

    const startResponse = await callAuth(env, "/auth/register/totp/start", {
      method: "POST",
      payload: { name: "alice" },
    });
    expect(startResponse.status).toBe(200);
    const startData = (await startResponse.json()) as {
      setupToken: string;
      secret: string;
    };
    expect(startData.setupToken.length).toBeGreaterThan(10);
    expect(startData.secret).toMatch(/^[A-Z2-7]+$/);

    const registerCode = await generateTotpCode(startData.secret, { nowMs: t0, digits: 6, periodSec: 30 });
    const verifyResponse = await withNow(t0, async () =>
      await callAuth(env, "/auth/register/totp/verify", {
        method: "POST",
        payload: { setupToken: startData.setupToken, code: registerCode },
      })
    );
    expect(verifyResponse.status).toBe(200);
    const verifyData = (await verifyResponse.json()) as { token: string };
    expect(verifyData.token.length).toBeGreaterThan(10);

    const sessionResponse = await callAuth(env, "/auth/session", {
      method: "GET",
      token: verifyData.token,
    });
    expect(sessionResponse.status).toBe(200);
    const sessionData = (await sessionResponse.json()) as { authenticated: boolean; hasTotp: boolean; user: { name: string } };
    expect(sessionData.authenticated).toBe(true);
    expect(sessionData.hasTotp).toBe(true);
    expect(sessionData.user.name).toBe("alice");

    const loginAt = t0 + 30_000;
    const loginCode = await generateTotpCode(startData.secret, { nowMs: loginAt, digits: 6, periodSec: 30 });
    const loginResponse = await withNow(loginAt, async () =>
      await callAuth(env, "/auth/login/totp", {
        method: "POST",
        payload: { username: "alice", code: loginCode },
      })
    );
    expect(loginResponse.status).toBe(200);
    const loginData = (await loginResponse.json()) as { token: string };
    expect(loginData.token.length).toBeGreaterThan(10);
  });

  test("rejects TOTP code replay in the same step", async () => {
    const env = createTestEnv();
    const t0 = Math.floor(Date.now() / 30_000) * 30_000 + 120_000;

    const startResponse = await callAuth(env, "/auth/register/totp/start", {
      method: "POST",
      payload: { name: "bob" },
    });
    const startData = (await startResponse.json()) as { setupToken: string; secret: string };
    const registerCode = await generateTotpCode(startData.secret, { nowMs: t0, digits: 6, periodSec: 30 });

    await withNow(t0, async () =>
      await callAuth(env, "/auth/register/totp/verify", {
        method: "POST",
        payload: { setupToken: startData.setupToken, code: registerCode },
      })
    );

    const loginAt = t0 + 30_000;
    const code = await generateTotpCode(startData.secret, { nowMs: loginAt, digits: 6, periodSec: 30 });
    const firstLogin = await withNow(loginAt, async () =>
      await callAuth(env, "/auth/login/totp", {
        method: "POST",
        payload: { username: "bob", code },
      })
    );
    expect(firstLogin.status).toBe(200);

    const secondLogin = await withNow(loginAt, async () =>
      await callAuth(env, "/auth/login/totp", {
        method: "POST",
        payload: { username: "bob", code },
      })
    );
    expect(secondLogin.status).toBe(400);
  });
});
