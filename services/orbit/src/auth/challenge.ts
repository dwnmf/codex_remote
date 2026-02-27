import type { AuthEnv } from "./env";
import type { ChallengeRecord } from "./types";

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseChallengeRecord(raw: unknown, expectedChallenge: string): ChallengeRecord | null {
  if (!isObject(raw)) return null;

  const value = raw.value;
  const type = raw.type;
  const expiresAt = raw.expiresAt;
  const userId = raw.userId;
  const pendingUser = raw.pendingUser;

  if (typeof value !== "string" || value.length === 0) return null;
  if (value !== expectedChallenge) return null;
  if (type !== "registration" && type !== "authentication") return null;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  if (userId !== undefined && typeof userId !== "string") return null;

  let parsedPendingUser: { id: string; name: string; displayName: string } | undefined;
  if (pendingUser !== undefined) {
    if (!isObject(pendingUser)) return null;
    if (
      typeof pendingUser.id !== "string" ||
      typeof pendingUser.name !== "string" ||
      typeof pendingUser.displayName !== "string"
    ) {
      return null;
    }
    parsedPendingUser = {
      id: pendingUser.id,
      name: pendingUser.name,
      displayName: pendingUser.displayName,
    };
  }

  return {
    value,
    type,
    expiresAt,
    userId,
    pendingUser: parsedPendingUser,
  };
}

export async function setChallenge(
  env: AuthEnv,
  challenge: string,
  opts: {
    type: "registration" | "authentication";
    userId?: string;
    pendingUser?: { id: string; name: string; displayName: string };
  }
): Promise<boolean> {
  if (!challenge) return false;

  const id = env.PASSKEY_CHALLENGE_DO.idFromName("default");
  const stub = env.PASSKEY_CHALLENGE_DO.get(id);
  const record: ChallengeRecord = {
    value: challenge,
    type: opts.type,
    userId: opts.userId,
    pendingUser: opts.pendingUser,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  };

  try {
    const response = await stub.fetch("https://challenge/set", {
      method: "POST",
      body: JSON.stringify({ key: challenge, record }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function consumeChallenge(
  env: AuthEnv,
  challenge: string
): Promise<ChallengeRecord | null> {
  if (!challenge) return null;

  const id = env.PASSKEY_CHALLENGE_DO.idFromName("default");
  const stub = env.PASSKEY_CHALLENGE_DO.get(id);

  try {
    const response = await stub.fetch("https://challenge/consume", {
      method: "POST",
      body: JSON.stringify({ key: challenge }),
    });
    if (!response.ok) return null;

    const data = (await response.json()) as { record?: unknown } | null;
    if (!data || data.record === undefined || data.record === null) return null;
    return parseChallengeRecord(data.record, challenge);
  } catch {
    return null;
  }
}
