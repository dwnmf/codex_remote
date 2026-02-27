import { describe, expect, mock, test } from "bun:test";

import type { AuthEnv } from "./env";
import { CHALLENGE_TTL_MS, consumeChallenge, setChallenge } from "./challenge";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

interface TestEnvResult {
  env: AuthEnv;
  fetchCalls: FetchCall[];
}

function createTestEnv(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): TestEnvResult {
  const fetchCalls: FetchCall[] = [];
  const stub = {
    fetch: (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      return fetchImpl(url, init);
    },
  };

  const env = {
    PASSKEY_CHALLENGE_DO: {
      idFromName: (_name: string) => "challenge-id",
      get: (_id: string) => stub,
    },
  } as unknown as AuthEnv;

  return { env, fetchCalls };
}

function bodyFromCall(call: FetchCall): unknown {
  return JSON.parse(call.init?.body as string);
}

describe("auth challenge store helpers", () => {
  test("setChallenge stores challenge record and returns true on success", async () => {
    const nowSpy = mock(() => 1_700_000_000_000);
    const originalNow = Date.now;
    Date.now = nowSpy;

    try {
      const { env, fetchCalls } = createTestEnv(async () => Response.json({ ok: true }, { status: 200 }));
      const stored = await setChallenge(env, "challenge-1", {
        type: "registration",
        pendingUser: { id: "u1", name: "alice", displayName: "Alice" },
      });

      expect(stored).toBe(true);
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]?.url).toBe("https://challenge/set");
      expect(fetchCalls[0]?.init?.method).toBe("POST");

      const body = bodyFromCall(fetchCalls[0]!) as { key: string; record: { expiresAt: number } };
      expect(body.key).toBe("challenge-1");
      expect(body.record.expiresAt).toBe(1_700_000_000_000 + CHALLENGE_TTL_MS);
    } finally {
      Date.now = originalNow;
    }
  });

  test("setChallenge returns false when storage request fails or challenge is empty", async () => {
    const { env: failingEnv } = createTestEnv(async () => {
      throw new Error("network");
    });
    await expect(setChallenge(failingEnv, "challenge-1", { type: "authentication", userId: "u1" })).resolves.toBe(false);

    const { env: emptyEnv, fetchCalls } = createTestEnv(async () => Response.json({ ok: true }, { status: 200 }));
    await expect(setChallenge(emptyEnv, "", { type: "authentication", userId: "u1" })).resolves.toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });

  test("consumeChallenge returns parsed record on success", async () => {
    const record = {
      value: "challenge-1",
      type: "authentication",
      userId: "u1",
      expiresAt: Date.now() + 1_000,
    };
    const { env, fetchCalls } = createTestEnv(async () => Response.json({ record }, { status: 200 }));

    const consumed = await consumeChallenge(env, "challenge-1");

    expect(consumed).toEqual(record);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("https://challenge/consume");
    expect(bodyFromCall(fetchCalls[0]!) as { key: string }).toEqual({ key: "challenge-1" });
  });

  test("consumeChallenge returns null for transport/http/json failures and empty challenge", async () => {
    const { env: throwingEnv } = createTestEnv(async () => {
      throw new Error("network");
    });
    await expect(consumeChallenge(throwingEnv, "challenge-1")).resolves.toBeNull();

    const { env: httpErrorEnv } = createTestEnv(async () => new Response("nope", { status: 500 }));
    await expect(consumeChallenge(httpErrorEnv, "challenge-1")).resolves.toBeNull();

    const { env: badJsonEnv } = createTestEnv(async () => new Response("{not json", { status: 200 }));
    await expect(consumeChallenge(badJsonEnv, "challenge-1")).resolves.toBeNull();

    const { env: emptyChallengeEnv, fetchCalls } = createTestEnv(async () => Response.json({ record: null }, { status: 200 }));
    await expect(consumeChallenge(emptyChallengeEnv, "")).resolves.toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });

  test("consumeChallenge rejects malformed record payloads", async () => {
    const badRecords: unknown[] = [
      {},
      { value: "challenge-1", type: "invalid", expiresAt: Date.now() + 1000 },
      { value: "challenge-1", type: "registration", expiresAt: "soon" },
      {
        value: "challenge-1",
        type: "registration",
        expiresAt: Date.now() + 1000,
        pendingUser: { id: "u1", name: 123, displayName: "Alice" },
      },
      { value: "different-challenge", type: "authentication", expiresAt: Date.now() + 1000 },
    ];

    for (const record of badRecords) {
      const { env } = createTestEnv(async () => Response.json({ record }, { status: 200 }));
      const consumed = await consumeChallenge(env, "challenge-1");
      expect(consumed).toBeNull();
    }
  });
});
