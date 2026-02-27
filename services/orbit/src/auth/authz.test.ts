import { describe, expect, test } from "bun:test";

import type { Env, Role } from "../types";
import { getRoleFromPath, isAuthorised } from "../ws/authz";

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    CODEX_REMOTE_WEB_JWT_SECRET: "web-secret",
    CODEX_REMOTE_ANCHOR_JWT_SECRET: "anchor-secret",
    DB: {} as D1Database,
    ORBIT_DO: {} as DurableObjectNamespace,
    PASSKEY_CHALLENGE_DO: {} as DurableObjectNamespace,
    ...overrides,
  };
}

function base64UrlEncode(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signHs256(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64UrlEncode(new Uint8Array(signature));
}

async function createJwt(
  secret: string,
  payload: { iss: string; aud: string; exp: number; sub?: string }
): Promise<string> {
  const headerPart = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payloadPart = base64UrlEncode(JSON.stringify(payload));
  const signaturePart = await signHs256(secret, `${headerPart}.${payloadPart}`);
  return `${headerPart}.${payloadPart}.${signaturePart}`;
}

function createRequest(token: string | null): Request {
  const headers = new Headers();
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return new Request("https://orbit.test/ws/client", { headers });
}

describe("ws authz", () => {
  test("maps websocket paths to roles with trailing slash normalization", () => {
    expect(getRoleFromPath("/ws/client")).toBe("client");
    expect(getRoleFromPath("/ws/client/")).toBe("client");
    expect(getRoleFromPath("/ws/anchor")).toBe("anchor");
    expect(getRoleFromPath("/ws/anchor///")).toBe("anchor");
    expect(getRoleFromPath("/ws/unknown")).toBeNull();
  });

  test("denies unsupported role values instead of falling back to anchor", async () => {
    const env = createEnv();
    const token = await createJwt(env.CODEX_REMOTE_ANCHOR_JWT_SECRET as string, {
      iss: "codex-remote-anchor",
      aud: "codex-remote-orbit-anchor",
      sub: "anchor-123",
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const result = await isAuthorised(createRequest(token), env, "unexpected-role" as Role);
    expect(result).toEqual({ authorised: false, userId: null, jwtType: null });
  });

  test("denies client auth when client secret is missing", async () => {
    const result = await isAuthorised(createRequest("any-token"), createEnv({ CODEX_REMOTE_WEB_JWT_SECRET: "   " }), "client");
    expect(result).toEqual({ authorised: false, userId: null, jwtType: null });
  });

  test("accepts valid client token", async () => {
    const env = createEnv();
    const token = await createJwt(env.CODEX_REMOTE_WEB_JWT_SECRET as string, {
      iss: "codex-remote-auth",
      aud: "codex-remote-web",
      sub: "user-123",
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const result = await isAuthorised(createRequest(token), env, "client");
    expect(result).toEqual({ authorised: true, userId: "user-123", jwtType: "web" });
  });

  test("rejects client token that verifies without a subject", async () => {
    const env = createEnv();
    const token = await createJwt(env.CODEX_REMOTE_WEB_JWT_SECRET as string, {
      iss: "codex-remote-auth",
      aud: "codex-remote-web",
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const result = await isAuthorised(createRequest(token), env, "client");
    expect(result).toEqual({ authorised: false, userId: null, jwtType: null });
  });

  test("accepts valid anchor token", async () => {
    const env = createEnv();
    const token = await createJwt(env.CODEX_REMOTE_ANCHOR_JWT_SECRET as string, {
      iss: "codex-remote-anchor",
      aud: "codex-remote-orbit-anchor",
      sub: "anchor-123",
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const result = await isAuthorised(createRequest(token), env, "anchor");
    expect(result).toEqual({ authorised: true, userId: "anchor-123", jwtType: "anchor" });
  });

  test("rejects missing token before verifier calls", async () => {
    const result = await isAuthorised(createRequest(null), createEnv(), "anchor");
    expect(result).toEqual({ authorised: false, userId: null, jwtType: null });
  });
});
