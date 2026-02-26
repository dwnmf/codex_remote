import { DurableObject } from "cloudflare:workers";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransport,
  RegistrationResponseJSON,
} from "@simplewebauthn/types";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { SignJWT, jwtVerify } from "jose";

import type { AuthEnv } from "./env";
import type { ChallengeRecord, DeviceCodeRecord, StoredCredential, StoredUser } from "./types";
import { authCorsHeaders, base64UrlDecode, base64UrlEncode, getRpId, isAllowedOrigin } from "./utils";
import { createSession, refreshSession, verifySession } from "./session";
import {
  consumeTotpStep,
  createUser,
  getCredential,
  getTotpFactorByUserId,
  getUserById,
  getUserByName,
  hasAnyUsers,
  listCredentials,
  randomUserId,
  revokeSession,
  updateCounter,
  upsertTotpFactor,
  upsertCredential,
} from "./db";
import { CHALLENGE_TTL_MS, consumeChallenge, setChallenge } from "./challenge";
import {
  buildTotpUri,
  createTotpSetupTokenPayload,
  generateTotpSecret,
  verifyTotpCode,
} from "./totp";

interface ChallengeStoreSetRequest {
  key: string;
  record: ChallengeRecord;
}

interface ChallengeStoreConsumeRequest {
  key: string;
}

interface RegisterOptionsRequest {
  name?: string;
  displayName?: string;
}

interface RegisterVerifyRequest {
  credential: RegistrationResponseJSON;
}

interface LoginOptionsRequest {
  username: string;
}

interface LoginVerifyRequest {
  credential: AuthenticationResponseJSON;
}

interface TotpRegisterStartRequest {
  name?: string;
  displayName?: string;
}

interface TotpRegisterVerifyRequest {
  setupToken?: string;
  code?: string;
}

interface TotpLoginRequest {
  username?: string;
  code?: string;
}

interface TotpSetupStartRequest {
  username?: string;
}

interface TotpSetupVerifyRequest {
  setupToken?: string;
  code?: string;
}

interface TotpSetupPayload {
  name: string;
  displayName: string;
  secretBase32: string;
  digits: number;
  periodSec: number;
  nonce: string;
  userId?: string;
}

const ANCHOR_ACCESS_TOKEN_TTL_SEC = 60 * 60;
const TOTP_SETUP_TOKEN_TTL_SEC = 10 * 60;
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SEC = 30;
const TOTP_ISSUER = "Zane";

function extractChallengeFromClientData(clientDataJSON: unknown): string | null {
  if (typeof clientDataJSON !== "string" || !clientDataJSON) return null;
  try {
    const decoded = new TextDecoder().decode(base64UrlDecode(clientDataJSON));
    const clientData = JSON.parse(decoded) as { challenge?: unknown };
    if (typeof clientData.challenge !== "string" || !clientData.challenge) return null;
    return clientData.challenge;
  } catch {
    return null;
  }
}

function parseTotpCode(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s|-/g, "").trim();
}

function getWebJwtSecret(env: AuthEnv): string | null {
  const secret = env.ZANE_WEB_JWT_SECRET?.trim();
  return secret || null;
}

async function createTotpSetupToken(env: AuthEnv, payload: TotpSetupPayload): Promise<string | null> {
  const secret = getWebJwtSecret(env);
  if (!secret) return null;

  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("zane-auth")
    .setAudience("zane-totp-setup")
    .setIssuedAt(now)
    .setExpirationTime(now + TOTP_SETUP_TOKEN_TTL_SEC)
    .sign(new TextEncoder().encode(secret));
}

async function verifyTotpSetupToken(env: AuthEnv, token: string): Promise<TotpSetupPayload | null> {
  const secret = getWebJwtSecret(env);
  if (!secret) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: "zane-auth",
      audience: "zane-totp-setup",
    });
    if (
      typeof payload.name !== "string" ||
      typeof payload.displayName !== "string" ||
      typeof payload.secretBase32 !== "string" ||
      typeof payload.digits !== "number" ||
      typeof payload.periodSec !== "number" ||
      typeof payload.nonce !== "string"
    ) {
      return null;
    }
    if (payload.userId !== undefined && typeof payload.userId !== "string") {
      return null;
    }
    return {
      name: payload.name,
      displayName: payload.displayName,
      secretBase32: payload.secretBase32,
      digits: payload.digits,
      periodSec: payload.periodSec,
      nonce: payload.nonce,
      userId: typeof payload.userId === "string" ? payload.userId : undefined,
    };
  } catch {
    return null;
  }
}

async function createAnchorAccessToken(env: AuthEnv, userId: string): Promise<{ token: string; expiresIn: number } | null> {
  const secret = env.ZANE_ANCHOR_JWT_SECRET?.trim();
  if (!secret) return null;

  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer("zane-anchor")
    .setAudience("zane-orbit-anchor")
    .setIssuedAt(now)
    .setExpirationTime(now + ANCHOR_ACCESS_TOKEN_TTL_SEC)
    .sign(new TextEncoder().encode(secret));

  return { token, expiresIn: ANCHOR_ACCESS_TOKEN_TTL_SEC };
}

export class PasskeyChallengeStore extends DurableObject<AuthEnv> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    if (url.pathname === "/set") {
      const body = (await req.json()) as ChallengeStoreSetRequest;
      if (!body?.key || !body?.record) {
        return new Response("Bad request", { status: 400 });
      }
      await this.ctx.storage.put(body.key, body.record);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/consume") {
      const body = (await req.json()) as ChallengeStoreConsumeRequest;
      if (!body?.key) {
        return new Response("Bad request", { status: 400 });
      }
      const record = await this.ctx.storage.get<ChallengeRecord>(body.key);
      if (!record) {
        return Response.json({ record: null });
      }
      if (Date.now() > record.expiresAt) {
        await this.ctx.storage.delete(body.key);
        return Response.json({ record: null });
      }
      await this.ctx.storage.delete(body.key);
      return Response.json({ record });
    }

    // ── Device code flow ──────────────────────────
    if (url.pathname === "/device/set") {
      const body = (await req.json()) as { record: DeviceCodeRecord };
      if (!body?.record) return new Response("Bad request", { status: 400 });
      const r = body.record;
      await this.ctx.storage.put(`device:user:${r.userCode}`, r);
      await this.ctx.storage.put(`device:poll:${r.deviceCode}`, r);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/device/poll") {
      const body = (await req.json()) as { deviceCode: string };
      if (!body?.deviceCode) return new Response("Bad request", { status: 400 });
      const record = await this.ctx.storage.get<DeviceCodeRecord>(`device:poll:${body.deviceCode}`);
      if (!record || Date.now() > record.expiresAt) {
        if (record) {
          await this.ctx.storage.delete(`device:poll:${body.deviceCode}`);
          await this.ctx.storage.delete(`device:user:${record.userCode}`);
        }
        return Response.json({ record: null });
      }
      return Response.json({ record });
    }

    if (url.pathname === "/device/authorise") {
      const body = (await req.json()) as { userCode: string; userId: string };
      if (!body?.userCode || !body?.userId) return new Response("Bad request", { status: 400 });
      const record = await this.ctx.storage.get<DeviceCodeRecord>(`device:user:${body.userCode}`);
      if (!record || Date.now() > record.expiresAt) {
        if (record) {
          await this.ctx.storage.delete(`device:user:${body.userCode}`);
          await this.ctx.storage.delete(`device:poll:${record.deviceCode}`);
        }
        return Response.json({ ok: false, error: "expired" });
      }
      const updated: DeviceCodeRecord = { ...record, status: "authorised", userId: body.userId };
      await this.ctx.storage.put(`device:user:${body.userCode}`, updated);
      await this.ctx.storage.put(`device:poll:${record.deviceCode}`, updated);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/device/consume") {
      const body = (await req.json()) as { deviceCode: string };
      if (!body?.deviceCode) return new Response("Bad request", { status: 400 });
      const record = await this.ctx.storage.get<DeviceCodeRecord>(`device:poll:${body.deviceCode}`);
      if (!record) return Response.json({ record: null });
      if (record.status !== "authorised") return Response.json({ record: null });
      await this.ctx.storage.delete(`device:poll:${body.deviceCode}`);
      await this.ctx.storage.delete(`device:user:${record.userCode}`);
      return Response.json({ record });
    }

    return new Response("Not found", { status: 404 });
  }
}

async function handleSession(req: Request, env: AuthEnv): Promise<Response> {
  const session = await verifySession(req, env);
  const systemHasUsers = await hasAnyUsers(env);

  let user = null;
  let hasPasskey = false;
  let hasTotp = false;

  if (session) {
    const storedUser = await getUserById(env, session.sub);
    if (storedUser) {
      user = { id: storedUser.id, name: storedUser.name };
      const credentials = await listCredentials(env, storedUser.id);
      hasPasskey = credentials.length > 0;
      hasTotp = Boolean(await getTotpFactorByUserId(env, storedUser.id));
    }
  }

  return Response.json(
    {
      authenticated: Boolean(session && user),
      user,
      hasPasskey,
      hasTotp,
      systemHasUsers,
    },
    { status: 200, headers: authCorsHeaders(req, env) }
  );
}

async function handleRegisterOptions(req: Request, env: AuthEnv): Promise<Response> {
  const session = await verifySession(req, env);
  const body = (await req.json()) as RegisterOptionsRequest;

  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin, env)) {
    return Response.json({ error: "Origin not allowed." }, { status: 403, headers: authCorsHeaders(req, env) });
  }

  let userId: string;
  let userName: string;
  let userDisplayName: string;
  let excludeCredentials: { id: string; transports?: StoredCredential["transports"] }[] = [];
  let pendingUser: { id: string; name: string; displayName: string } | undefined;

  if (session) {
    // Adding a passkey to an existing account
    const existing = await getUserById(env, session.sub);
    if (!existing) {
      return Response.json({ error: "User not found." }, { status: 404, headers: authCorsHeaders(req, env) });
    }
    userId = existing.id;
    userName = existing.name;
    userDisplayName = existing.displayName;
    const credentials = await listCredentials(env, existing.id);
    excludeCredentials = credentials.map((c) => ({ id: c.id, transports: c.transports }));
  } else {
    // New user registration — defer user creation to verify step
    const name = body.name?.trim();
    const displayName = body.displayName?.trim() || name;
    if (!name) {
      return Response.json({ error: "Name is required." }, { status: 400, headers: authCorsHeaders(req, env) });
    }

    const existingByName = await getUserByName(env, name);
    if (existingByName) {
      return Response.json({ error: "Registration failed." }, { status: 400, headers: authCorsHeaders(req, env) });
    }

    userId = randomUserId();
    userName = name;
    userDisplayName = displayName!;
    pendingUser = { id: userId, name, displayName: userDisplayName };
  }

  const rpID = getRpId(origin!);

  const options = await generateRegistrationOptions({
    rpName: "Zane",
    rpID,
    userID: base64UrlDecode(userId),
    userName,
    userDisplayName,
    attestationType: "none",
    timeout: CHALLENGE_TTL_MS,
    excludeCredentials,
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
    },
  });

  const stored = await setChallenge(env, options.challenge, {
    type: "registration",
    userId: session ? userId : undefined,
    pendingUser,
  });
  if (!stored) {
    return Response.json({ error: "Failed to persist challenge." }, { status: 500, headers: authCorsHeaders(req, env) });
  }

  return Response.json(options, { status: 200, headers: authCorsHeaders(req, env) });
}

async function handleRegisterVerify(req: Request, env: AuthEnv): Promise<Response> {
  const body = (await req.json()) as RegisterVerifyRequest;
  if (!body?.credential) {
    return Response.json({ error: "Invalid payload." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin, env)) {
    return Response.json({ error: "Origin not allowed." }, { status: 403, headers: authCorsHeaders(req, env) });
  }

  // Extract and consume the challenge before verification
  const challenge = extractChallengeFromClientData(body.credential.response.clientDataJSON);
  if (!challenge) {
    return Response.json({ error: "Malformed clientDataJSON." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const challengeRecord = await consumeChallenge(env, challenge);
  if (!challengeRecord) {
    return Response.json({ error: "Registration challenge expired." }, { status: 400, headers: authCorsHeaders(req, env) });
  }
  if (challengeRecord.type !== "registration") {
    return Response.json({ error: "Invalid registration challenge." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const rpID = getRpId(origin!);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.credential,
      expectedChallenge: challengeRecord.value,
      expectedOrigin: origin!,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch {
    return Response.json(
      { error: "Registration verification failed." },
      { status: 400, headers: authCorsHeaders(req, env) }
    );
  }

  if (!verification.verified || !verification.registrationInfo) {
    return Response.json({ error: "Registration not verified." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  // Resolve the user: existing account (adding passkey) or new registration
  let user: StoredUser;
  if (challengeRecord.userId) {
    const existing = await getUserById(env, challengeRecord.userId);
    if (!existing) {
      return Response.json({ error: "User not found." }, { status: 404, headers: authCorsHeaders(req, env) });
    }
    user = existing;
  } else if (challengeRecord.pendingUser) {
    // Re-check uniqueness in case of a race between two concurrent registrations
    const existingByName = await getUserByName(env, challengeRecord.pendingUser.name);
    if (existingByName) {
      return Response.json({ error: "Registration failed." }, { status: 400, headers: authCorsHeaders(req, env) });
    }
    user = await createUser(env, challengeRecord.pendingUser.name, challengeRecord.pendingUser.displayName);
  } else {
    return Response.json({ error: "Invalid challenge record." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const info = verification.registrationInfo;
  const credentialId = info.credential.id;
  const existingCredentials = await listCredentials(env, user.id);
  const existing = existingCredentials.find((credential) => credential.id === credentialId);

  if (!existing) {
    await upsertCredential(env, {
      id: credentialId,
      userId: user.id,
      publicKey: base64UrlEncode(info.credential.publicKey),
      counter: info.credential.counter,
      transports: body.credential.response.transports as AuthenticatorTransport[] | undefined,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp ?? false,
    });
  }

  const session = await createSession(env, user);
  return Response.json(
    {
      verified: true,
      token: session.token,
      refreshToken: session.refreshToken,
      user: { id: user.id, name: user.name },
    },
    { status: 200, headers: authCorsHeaders(req, env) }
  );
}

async function handleLoginOptions(req: Request, env: AuthEnv): Promise<Response> {
  const body = (await req.json()) as LoginOptionsRequest;
  const username = body.username?.trim();
  if (!username) {
    return Response.json({ error: "Username is required." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const user = await getUserByName(env, username);
  if (!user) {
    return Response.json({ error: "Invalid credentials." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const credentials = await listCredentials(env, user.id);
  if (credentials.length === 0) {
    return Response.json({ error: "Invalid credentials." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin, env)) {
    return Response.json({ error: "Origin not allowed." }, { status: 403, headers: authCorsHeaders(req, env) });
  }

  const rpID = getRpId(origin!);

  const allowCredentials = credentials.map((credential) => ({
    id: credential.id,
    transports: credential.transports,
  }));

  const options = await generateAuthenticationOptions({
    rpID,
    timeout: CHALLENGE_TTL_MS,
    allowCredentials,
    userVerification: "required",
  });

  const stored = await setChallenge(env, options.challenge, { type: "authentication", userId: user.id });
  if (!stored) {
    return Response.json({ error: "Failed to persist challenge." }, { status: 500, headers: authCorsHeaders(req, env) });
  }

  return Response.json(options, { status: 200, headers: authCorsHeaders(req, env) });
}

async function handleLoginVerify(req: Request, env: AuthEnv): Promise<Response> {
  const body = (await req.json()) as LoginVerifyRequest;
  if (!body?.credential) {
    return Response.json({ error: "Invalid payload." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin, env)) {
    return Response.json({ error: "Origin not allowed." }, { status: 403, headers: authCorsHeaders(req, env) });
  }

  const credential = await getCredential(env, body.credential.id);
  if (!credential) {
    return Response.json({ error: "Unknown credential." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const user = await getUserById(env, credential.userId);
  if (!user) {
    return Response.json({ error: "User not found." }, { status: 404, headers: authCorsHeaders(req, env) });
  }

  // Extract challenge from clientDataJSON to consume the stored record
  const challenge = extractChallengeFromClientData(body.credential.response.clientDataJSON);
  if (!challenge) {
    return Response.json({ error: "Malformed clientDataJSON." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const challengeRecord = await consumeChallenge(env, challenge);
  if (!challengeRecord) {
    return Response.json(
      { error: "Authentication challenge expired." },
      { status: 400, headers: authCorsHeaders(req, env) }
    );
  }
  if (challengeRecord.type !== "authentication") {
    return Response.json({ error: "Invalid authentication challenge." }, { status: 400, headers: authCorsHeaders(req, env) });
  }
  if (challengeRecord.userId && challengeRecord.userId !== user.id) {
    return Response.json({ error: "Challenge/user mismatch." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const rpID = getRpId(origin!);

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.credential,
      expectedChallenge: challengeRecord.value,
      expectedOrigin: origin!,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: credential.id,
        publicKey: base64UrlDecode(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports,
      },
    });
  } catch {
    return Response.json(
      { error: "Authentication verification failed." },
      { status: 400, headers: authCorsHeaders(req, env) }
    );
  }

  if (!verification.verified || !verification.authenticationInfo) {
    return Response.json({ error: "Authentication not verified." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  await updateCounter(env, credential.id, verification.authenticationInfo.newCounter);

  const session = await createSession(env, user);
  return Response.json(
    {
      verified: true,
      token: session.token,
      refreshToken: session.refreshToken,
      user: { id: user.id, name: user.name },
    },
    { status: 200, headers: authCorsHeaders(req, env) }
  );
}

async function handleTotpRegisterStart(req: Request, env: AuthEnv): Promise<Response> {
  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin, env)) {
    return Response.json({ error: "Origin not allowed." }, { status: 403, headers: authCorsHeaders(req, env) });
  }

  const body = (await req.json()) as TotpRegisterStartRequest;
  const name = body.name?.trim();
  const displayName = body.displayName?.trim() || name;
  if (!name) {
    return Response.json({ error: "Name is required." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const existing = await getUserByName(env, name);
  if (existing) {
    return Response.json({ error: "Registration failed." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const secretBase32 = generateTotpSecret();
  const payload: TotpSetupPayload = createTotpSetupTokenPayload({
    name,
    displayName: displayName || name,
    secretBase32,
    digits: TOTP_DIGITS,
    periodSec: TOTP_PERIOD_SEC,
  });
  const setupToken = await createTotpSetupToken(env, payload);
  if (!setupToken) {
    return Response.json({ error: "Auth secret not configured." }, { status: 503, headers: authCorsHeaders(req, env) });
  }

  const otpauthUrl = buildTotpUri({
    secretBase32,
    accountName: name,
    issuer: TOTP_ISSUER,
    digits: TOTP_DIGITS,
    periodSec: TOTP_PERIOD_SEC,
  });
  return Response.json(
    {
      setupToken,
      secret: secretBase32,
      otpauthUrl,
      issuer: TOTP_ISSUER,
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SEC,
    },
    { status: 200, headers: authCorsHeaders(req, env) }
  );
}

async function handleTotpRegisterVerify(req: Request, env: AuthEnv): Promise<Response> {
  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin, env)) {
    return Response.json({ error: "Origin not allowed." }, { status: 403, headers: authCorsHeaders(req, env) });
  }

  const body = (await req.json()) as TotpRegisterVerifyRequest;
  const setupToken = body.setupToken?.trim();
  const code = parseTotpCode(body.code);
  if (!setupToken || !code) {
    return Response.json({ error: "setupToken and code are required." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const payload = await verifyTotpSetupToken(env, setupToken);
  if (!payload) {
    return Response.json({ error: "Setup token expired." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const existing = await getUserByName(env, payload.name);
  if (existing) {
    return Response.json({ error: "Registration failed." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const verification = await verifyTotpCode(payload.secretBase32, code, {
    digits: payload.digits,
    periodSec: payload.periodSec,
    window: 1,
  });
  if (!verification.valid || verification.step === null) {
    return Response.json({ error: "Invalid code." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  let user: StoredUser;
  try {
    user = await createUser(env, payload.name, payload.displayName);
  } catch {
    return Response.json({ error: "Registration failed." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  await upsertTotpFactor(env, {
    userId: user.id,
    secretBase32: payload.secretBase32,
    digits: payload.digits,
    periodSec: payload.periodSec,
    algorithm: "SHA1",
    lastUsedStep: verification.step,
  });

  const session = await createSession(env, user);
  return Response.json(
    {
      verified: true,
      token: session.token,
      refreshToken: session.refreshToken,
      user: { id: user.id, name: user.name },
    },
    { status: 200, headers: authCorsHeaders(req, env) }
  );
}

async function handleTotpLogin(req: Request, env: AuthEnv): Promise<Response> {
  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin, env)) {
    return Response.json({ error: "Origin not allowed." }, { status: 403, headers: authCorsHeaders(req, env) });
  }

  const body = (await req.json()) as TotpLoginRequest;
  const username = body.username?.trim();
  const code = parseTotpCode(body.code);
  if (!username || !code) {
    return Response.json({ error: "Invalid credentials." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const user = await getUserByName(env, username);
  if (!user) {
    return Response.json({ error: "Invalid credentials." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const factor = await getTotpFactorByUserId(env, user.id);
  if (!factor) {
    return Response.json({ error: "Invalid credentials." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const verification = await verifyTotpCode(factor.secretBase32, code, {
    digits: factor.digits,
    periodSec: factor.periodSec,
    window: 1,
  });
  if (!verification.valid || verification.step === null) {
    return Response.json({ error: "Invalid credentials." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const consumed = await consumeTotpStep(env, user.id, verification.step);
  if (!consumed) {
    return Response.json({ error: "Invalid credentials." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const session = await createSession(env, user);
  return Response.json(
    {
      verified: true,
      token: session.token,
      refreshToken: session.refreshToken,
      user: { id: user.id, name: user.name },
    },
    { status: 200, headers: authCorsHeaders(req, env) }
  );
}

async function handleTotpSetupStart(req: Request, env: AuthEnv): Promise<Response> {
  const session = await verifySession(req, env);
  if (!session) {
    return Response.json({ error: "Authentication required." }, { status: 401, headers: authCorsHeaders(req, env) });
  }

  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin, env)) {
    return Response.json({ error: "Origin not allowed." }, { status: 403, headers: authCorsHeaders(req, env) });
  }

  const user = await getUserById(env, session.sub);
  if (!user) {
    return Response.json({ error: "User not found." }, { status: 404, headers: authCorsHeaders(req, env) });
  }

  const body = (await req.json()) as TotpSetupStartRequest;
  const username = body.username?.trim() || user.name;
  const secretBase32 = generateTotpSecret();
  const payload: TotpSetupPayload = createTotpSetupTokenPayload({
    name: username,
    displayName: user.displayName,
    secretBase32,
    digits: TOTP_DIGITS,
    periodSec: TOTP_PERIOD_SEC,
    userId: user.id,
  });
  const setupToken = await createTotpSetupToken(env, payload);
  if (!setupToken) {
    return Response.json({ error: "Auth secret not configured." }, { status: 503, headers: authCorsHeaders(req, env) });
  }

  const otpauthUrl = buildTotpUri({
    secretBase32,
    accountName: username,
    issuer: TOTP_ISSUER,
    digits: TOTP_DIGITS,
    periodSec: TOTP_PERIOD_SEC,
  });
  return Response.json(
    {
      setupToken,
      secret: secretBase32,
      otpauthUrl,
      issuer: TOTP_ISSUER,
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SEC,
    },
    { status: 200, headers: authCorsHeaders(req, env) }
  );
}

async function handleTotpSetupVerify(req: Request, env: AuthEnv): Promise<Response> {
  const session = await verifySession(req, env);
  if (!session) {
    return Response.json({ error: "Authentication required." }, { status: 401, headers: authCorsHeaders(req, env) });
  }

  const origin = req.headers.get("origin");
  if (!isAllowedOrigin(origin, env)) {
    return Response.json({ error: "Origin not allowed." }, { status: 403, headers: authCorsHeaders(req, env) });
  }

  const body = (await req.json()) as TotpSetupVerifyRequest;
  const setupToken = body.setupToken?.trim();
  const code = parseTotpCode(body.code);
  if (!setupToken || !code) {
    return Response.json({ error: "setupToken and code are required." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const payload = await verifyTotpSetupToken(env, setupToken);
  if (!payload) {
    return Response.json({ error: "Setup token expired." }, { status: 400, headers: authCorsHeaders(req, env) });
  }
  if (!payload.userId || payload.userId !== session.sub) {
    return Response.json({ error: "Setup token user mismatch." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const verification = await verifyTotpCode(payload.secretBase32, code, {
    digits: payload.digits,
    periodSec: payload.periodSec,
    window: 1,
  });
  if (!verification.valid || verification.step === null) {
    return Response.json({ error: "Invalid code." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  await upsertTotpFactor(env, {
    userId: session.sub,
    secretBase32: payload.secretBase32,
    digits: payload.digits,
    periodSec: payload.periodSec,
    algorithm: "SHA1",
    lastUsedStep: verification.step,
  });

  return Response.json({ verified: true, hasTotp: true }, { status: 200, headers: authCorsHeaders(req, env) });
}

const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
const DEVICE_CODE_POLL_INTERVAL = 5;

function generateUserCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function generateDeviceCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64UrlEncode(bytes);
}

function getDoStub(env: AuthEnv) {
  const id = env.PASSKEY_CHALLENGE_DO.idFromName("default");
  return env.PASSKEY_CHALLENGE_DO.get(id);
}

async function handleDeviceCode(req: Request, env: AuthEnv): Promise<Response> {
  const deviceCode = generateDeviceCode();
  const userCode = generateUserCode();
  const record: DeviceCodeRecord = {
    deviceCode,
    userCode,
    status: "pending",
    expiresAt: Date.now() + DEVICE_CODE_TTL_MS,
  };

  const stub = getDoStub(env);
  const res = await stub.fetch("https://do/device/set", {
    method: "POST",
    body: JSON.stringify({ record }),
  });
  if (!res.ok) {
    return Response.json({ error: "Failed to create device code." }, { status: 500, headers: authCorsHeaders(req, env) });
  }

  const origin = env.PASSKEY_ORIGIN ?? "";
  return Response.json(
    {
      deviceCode,
      userCode,
      verificationUrl: `${origin}/device`,
      expiresIn: Math.floor(DEVICE_CODE_TTL_MS / 1000),
      interval: DEVICE_CODE_POLL_INTERVAL,
    },
    { status: 200, headers: authCorsHeaders(req, env) }
  );
}

async function handleDeviceToken(req: Request, env: AuthEnv): Promise<Response> {
  const body = (await req.json()) as { deviceCode?: string };
  if (!body?.deviceCode) {
    return Response.json({ error: "deviceCode is required." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const stub = getDoStub(env);

  // First check status without consuming
  const pollRes = await stub.fetch("https://do/device/poll", {
    method: "POST",
    body: JSON.stringify({ deviceCode: body.deviceCode }),
  });
  const pollData = (await pollRes.json()) as { record: DeviceCodeRecord | null };

  if (!pollData.record) {
    return Response.json({ status: "expired" }, { status: 200, headers: authCorsHeaders(req, env) });
  }

  if (pollData.record.status === "pending") {
    return Response.json({ status: "pending" }, { status: 200, headers: authCorsHeaders(req, env) });
  }

  // Check secret exists before consuming (so record survives retries if misconfigured)
  const anchorSecret = env.ZANE_ANCHOR_JWT_SECRET?.trim();
  if (!anchorSecret) {
    return Response.json({ error: "Anchor secret not configured on Orbit." }, { status: 503, headers: authCorsHeaders(req, env) });
  }

  const consumeRes = await stub.fetch("https://do/device/consume", {
    method: "POST",
    body: JSON.stringify({ deviceCode: body.deviceCode }),
  });
  const consumeData = (await consumeRes.json()) as { record: DeviceCodeRecord | null };

  if (!consumeData.record) {
    return Response.json({ status: "expired" }, { status: 200, headers: authCorsHeaders(req, env) });
  }

  return Response.json(
    {
      status: "authorised",
      userId: consumeData.record.userId,
      anchorJwtSecret: anchorSecret,
    },
    { status: 200, headers: authCorsHeaders(req, env) }
  );
}

async function handleDeviceAuthorise(req: Request, env: AuthEnv): Promise<Response> {
  const session = await verifySession(req, env);
  if (!session) {
    return Response.json({ error: "Authentication required." }, { status: 401, headers: authCorsHeaders(req, env) });
  }

  const body = (await req.json()) as { userCode?: string };
  if (!body?.userCode) {
    return Response.json({ error: "userCode is required." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const stub = getDoStub(env);
  const res = await stub.fetch("https://do/device/authorise", {
    method: "POST",
    body: JSON.stringify({ userCode: body.userCode.toUpperCase().trim(), userId: session.sub }),
  });
  const data = (await res.json()) as { ok: boolean; error?: string };

  if (!data.ok) {
    return Response.json(
      { error: data.error === "expired" ? "Code expired or not found." : "Authorisation failed." },
      { status: 400, headers: authCorsHeaders(req, env) }
    );
  }

  return Response.json({ ok: true }, { status: 200, headers: authCorsHeaders(req, env) });
}

async function handleRefresh(req: Request, env: AuthEnv): Promise<Response> {
  let body: { refreshToken?: string };
  try {
    body = (await req.json()) as { refreshToken?: string };
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400, headers: authCorsHeaders(req, env) });
  }
  if (!body?.refreshToken) {
    return Response.json({ error: "refreshToken is required." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const result = await refreshSession(env, body.refreshToken);
  if (!result) {
    return Response.json({ error: "Invalid or expired refresh token." }, { status: 401, headers: authCorsHeaders(req, env) });
  }

  return Response.json(
    { token: result.tokens.token, refreshToken: result.tokens.refreshToken, user: result.user },
    { status: 200, headers: authCorsHeaders(req, env) }
  );
}

async function handleDeviceRefresh(req: Request, env: AuthEnv): Promise<Response> {
  let body: { refreshToken?: string };
  try {
    body = (await req.json()) as { refreshToken?: string };
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  if (!body?.refreshToken) {
    return Response.json({ error: "refreshToken is required." }, { status: 400, headers: authCorsHeaders(req, env) });
  }

  const result = await refreshSession(env, body.refreshToken);
  if (!result) {
    return Response.json({ error: "Invalid or expired refresh token." }, { status: 401, headers: authCorsHeaders(req, env) });
  }

  const anchorAccess = await createAnchorAccessToken(env, result.user.id);
  if (!anchorAccess) {
    return Response.json({ error: "Anchor secret not configured on Orbit." }, { status: 503, headers: authCorsHeaders(req, env) });
  }

  return Response.json(
    {
      anchorAccessToken: anchorAccess.token,
      anchorRefreshToken: result.tokens.refreshToken,
      anchorAccessExpiresIn: anchorAccess.expiresIn,
      userId: result.user.id,
    },
    { status: 200, headers: authCorsHeaders(req, env) }
  );
}

async function handleLogout(req: Request, env: AuthEnv): Promise<Response> {
  const session = await verifySession(req, env);
  if (session) {
    await revokeSession(env, session.jti);
  }
  return new Response(null, { status: 204, headers: authCorsHeaders(req, env) });
}

export async function handleAuthRequest(req: Request, env: AuthEnv): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/auth/")) {
    return null;
  }

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: authCorsHeaders(req, env) });
  }

  if (url.pathname === "/auth/session" && req.method === "GET") {
    return await handleSession(req, env);
  }

  if (url.pathname === "/auth/register/options" && req.method === "POST") {
    return await handleRegisterOptions(req, env);
  }

  if (url.pathname === "/auth/register/verify" && req.method === "POST") {
    return await handleRegisterVerify(req, env);
  }

  if (url.pathname === "/auth/login/options" && req.method === "POST") {
    return await handleLoginOptions(req, env);
  }

  if (url.pathname === "/auth/login/verify" && req.method === "POST") {
    return await handleLoginVerify(req, env);
  }

  if (url.pathname === "/auth/login/totp" && req.method === "POST") {
    return await handleTotpLogin(req, env);
  }

  if (url.pathname === "/auth/register/totp/start" && req.method === "POST") {
    return await handleTotpRegisterStart(req, env);
  }

  if (url.pathname === "/auth/register/totp/verify" && req.method === "POST") {
    return await handleTotpRegisterVerify(req, env);
  }

  if (url.pathname === "/auth/totp/setup/options" && req.method === "POST") {
    return await handleTotpSetupStart(req, env);
  }

  if (url.pathname === "/auth/totp/setup/verify" && req.method === "POST") {
    return await handleTotpSetupVerify(req, env);
  }

  if (url.pathname === "/auth/refresh" && req.method === "POST") {
    return await handleRefresh(req, env);
  }

  if (url.pathname === "/auth/device/refresh" && req.method === "POST") {
    return await handleDeviceRefresh(req, env);
  }

  if (url.pathname === "/auth/logout" && req.method === "POST") {
    return await handleLogout(req, env);
  }

  if (url.pathname === "/auth/device/code" && req.method === "POST") {
    return await handleDeviceCode(req, env);
  }

  if (url.pathname === "/auth/device/token" && req.method === "POST") {
    return await handleDeviceToken(req, env);
  }

  if (url.pathname === "/auth/device/authorise" && req.method === "POST") {
    return await handleDeviceAuthorise(req, env);
  }

  return new Response("Not found", { status: 404, headers: authCorsHeaders(req, env) });
}
