import { SignJWT, jwtVerify } from "npm:jose";

import type { KvStore } from "./kv-store.ts";
import type { SessionPayload, Settings, UserRecord } from "./types.ts";
import { nowSec } from "./utils.ts";

export async function createWebSessionToken(
  settings: Settings,
  user: UserRecord,
  sessionId: string,
): Promise<string> {
  const now = nowSec();
  return await new SignJWT({ name: user.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuer("codex-remote-auth")
    .setAudience("codex-remote-web")
    .setIssuedAt(now)
    .setExpirationTime(now + settings.accessTtlSec)
    .setJti(sessionId)
    .sign(new TextEncoder().encode(settings.webJwtSecret));
}

export async function verifyWebToken(
  settings: Settings,
  store: KvStore,
  token: string,
): Promise<SessionPayload | null> {
  try {
    const key = new TextEncoder().encode(settings.webJwtSecret);
    const { payload } = await jwtVerify(token, key, {
      issuer: "codex-remote-auth",
      audience: "codex-remote-web",
    });

    if (typeof payload.sub !== "string" || typeof payload.name !== "string" || typeof payload.jti !== "string") {
      return null;
    }

    const session = await store.getActiveWebSession(payload.jti);
    if (!session || session.userId !== payload.sub) {
      return null;
    }

    return {
      sub: payload.sub,
      name: payload.name,
      jti: payload.jti,
    };
  } catch {
    return null;
  }
}

export async function verifyAnchorAnyToken(
  settings: Settings,
  store: KvStore,
  token: string,
): Promise<{ sub: string } | null> {
  const opaque = await store.verifyAnchorAccessToken(token);
  if (opaque) {
    return { sub: opaque.userId };
  }

  if (!settings.anchorJwtSecret) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(settings.anchorJwtSecret), {
      issuer: "codex-remote-anchor",
      audience: "codex-remote-orbit-anchor",
    });
    if (typeof payload.sub !== "string") {
      return null;
    }
    return { sub: payload.sub };
  } catch {
    return null;
  }
}
