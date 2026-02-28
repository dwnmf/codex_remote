import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "npm:@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "npm:@simplewebauthn/types";

import type { KvStore } from "./kv-store.ts";
import {
  asString,
  emptyWithCors,
  extractChallengeFromClientData,
  getDeviceVerificationUrl,
  getRequestToken,
  isOriginAllowed,
  jsonWithCors,
  parseJson,
  resolveRpId,
} from "./utils.ts";
import type { Settings, UserRecord } from "./types.ts";
import { createWebSessionToken, verifyAnchorAnyToken, verifyWebToken } from "./jwt.ts";
import { base64UrlDecode, base64UrlEncode, nowSec, randomId } from "./utils.ts";

export async function getAuthenticatedUser(
  settings: Settings,
  store: KvStore,
  req: Request,
): Promise<UserRecord | null> {
  const token = getRequestToken(req);
  if (!token) return null;

  const payload = await verifyWebToken(settings, store, token);
  if (!payload) return null;

  return await store.getUserById(payload.sub);
}

async function createUserSessionResponse(
  settings: Settings,
  store: KvStore,
  req: Request,
  user: UserRecord,
): Promise<Response> {
  const { session, refreshToken } = await store.createWebSession(user.id);
  const token = await createWebSessionToken(settings, user, session.id);

  return jsonWithCors(settings, req, {
    verified: true,
    token,
    refreshToken,
    user: { id: user.id, name: user.name },
  });
}

async function handleSession(settings: Settings, store: KvStore, req: Request): Promise<Response> {
  const user = await getAuthenticatedUser(settings, store, req);
  const hasUsers = await store.hasAnyUsers();
  const hasPasskey = user ? (await store.listCredentials(user.id)).length > 0 : false;

  return jsonWithCors(settings, req, {
    authenticated: Boolean(user),
    user: user ? { id: user.id, name: user.name } : null,
    hasPasskey,
    hasTotp: false,
    systemHasUsers: hasUsers,
  });
}

async function handleRegisterBasic(settings: Settings, store: KvStore, req: Request): Promise<Response> {
  if (settings.authMode !== "basic") {
    return jsonWithCors(settings, req, { error: "Basic auth mode is disabled." }, 400);
  }

  const body = await parseJson(req);
  const name = asString(body?.name);
  const displayName = asString(body?.displayName) ?? name;

  if (!name) {
    return jsonWithCors(settings, req, { error: "Name is required." }, 400);
  }

  const existing = await store.getUserByName(name);
  if (existing) {
    return jsonWithCors(settings, req, { error: "User already exists." }, 400);
  }

  const created = await store.createUser(name, displayName ?? name);
  if (!created) {
    return jsonWithCors(settings, req, { error: "User already exists." }, 400);
  }

  return await createUserSessionResponse(settings, store, req, created);
}

async function handleLoginBasic(settings: Settings, store: KvStore, req: Request): Promise<Response> {
  if (settings.authMode !== "basic") {
    return jsonWithCors(settings, req, { error: "Basic auth mode is disabled." }, 400);
  }

  const body = await parseJson(req);
  const username = asString(body?.username);
  if (!username) {
    return jsonWithCors(settings, req, { error: "Username is required." }, 400);
  }

  const user = await store.getUserByName(username);
  if (!user) {
    return jsonWithCors(settings, req, { error: "Invalid credentials." }, 400);
  }

  return await createUserSessionResponse(settings, store, req, user);
}

async function handleRegisterOptions(settings: Settings, store: KvStore, req: Request): Promise<Response> {
  if (settings.authMode !== "passkey") {
    return jsonWithCors(settings, req, { error: "Passkey flow is disabled. Use AUTH_MODE=basic." }, 400);
  }

  const origin = req.headers.get("origin");
  if (!isOriginAllowed(settings, origin)) {
    return jsonWithCors(settings, req, { error: "Origin not allowed." }, 403);
  }

  const body = await parseJson(req);
  const session = await getAuthenticatedUser(settings, store, req);

  let userId = "";
  let userName = "";
  let userDisplayName = "";
  let excludeCredentials: { id: string; transports?: AuthenticatorTransportFuture[] }[] = [];
  let pendingName: string | null = null;
  let pendingDisplayName: string | null = null;

  if (session) {
    userId = session.id;
    userName = session.name;
    userDisplayName = session.displayName;
    const credentials = await store.listCredentials(session.id);
    excludeCredentials = credentials.map((credential) => ({ id: credential.id, transports: credential.transports as AuthenticatorTransportFuture[] | undefined }));
  } else {
    const name = asString(body?.name);
    const displayName = asString(body?.displayName) ?? name;
    if (!name) {
      return jsonWithCors(settings, req, { error: "Name is required." }, 400);
    }

    const existing = await store.getUserByName(name);
    if (existing) {
      return jsonWithCors(settings, req, { error: "Registration failed." }, 400);
    }

    userId = randomId(16);
    userName = name;
    userDisplayName = displayName ?? name;
    pendingName = name;
    pendingDisplayName = userDisplayName;
  }

  const rpId = resolveRpId(settings, origin!);

  const options = await generateRegistrationOptions({
    rpName: "Codex Remote",
    rpID: rpId,
    userID: new TextEncoder().encode(userId),
    userName,
    userDisplayName,
    timeout: settings.challengeTtlSec * 1000,
    attestationType: "none",
    excludeCredentials,
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
    },
  });

  await store.setChallenge({
    challenge: options.challenge,
    kind: "registration",
    userId: session ? session.id : null,
    pendingName,
    pendingDisplayName,
    expiresAt: Date.now() + settings.challengeTtlSec * 1000,
    createdAt: Date.now(),
  });

  return jsonWithCors(settings, req, options, 200);
}

async function handleRegisterVerify(settings: Settings, store: KvStore, req: Request): Promise<Response> {
  if (settings.authMode !== "passkey") {
    return jsonWithCors(settings, req, { error: "Passkey flow is disabled. Use AUTH_MODE=basic." }, 400);
  }

  const origin = req.headers.get("origin");
  if (!isOriginAllowed(settings, origin)) {
    return jsonWithCors(settings, req, { error: "Origin not allowed." }, 403);
  }

  const body = await parseJson(req);
  const credential = body?.credential as RegistrationResponseJSON | undefined;
  if (!credential || typeof credential !== "object") {
    return jsonWithCors(settings, req, { error: "Invalid payload." }, 400);
  }

  const challenge = extractChallengeFromClientData(credential.response?.clientDataJSON);
  if (!challenge) {
    return jsonWithCors(settings, req, { error: "Malformed clientDataJSON." }, 400);
  }

  const challengeRecord = await store.consumeChallenge(challenge, "registration");
  if (!challengeRecord) {
    return jsonWithCors(settings, req, { error: "Registration challenge expired." }, 400);
  }

  const rpId = resolveRpId(settings, origin!);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: challengeRecord.challenge,
      expectedOrigin: origin!,
      expectedRPID: rpId,
      requireUserVerification: true,
    });
  } catch {
    return jsonWithCors(settings, req, { error: "Registration verification failed." }, 400);
  }

  if (!verification.verified || !verification.registrationInfo) {
    return jsonWithCors(settings, req, { error: "Registration not verified." }, 400);
  }

  let user: UserRecord | null = null;

  if (challengeRecord.userId) {
    user = await store.getUserById(challengeRecord.userId);
    if (!user) {
      return jsonWithCors(settings, req, { error: "User not found." }, 404);
    }
  } else {
    const name = challengeRecord.pendingName?.trim() ?? "";
    const displayName = challengeRecord.pendingDisplayName?.trim() || name;
    if (!name) {
      return jsonWithCors(settings, req, { error: "Invalid challenge record." }, 400);
    }

    const existing = await store.getUserByName(name);
    if (existing) {
      return jsonWithCors(settings, req, { error: "Registration failed." }, 400);
    }

    user = await store.createUser(name, displayName);
    if (!user) {
      return jsonWithCors(settings, req, { error: "Registration failed." }, 400);
    }
  }

  const info = verification.registrationInfo;
  const credentialId = info.credential.id;
  const existingCredential = await store.getCredential(credentialId);

  if (!existingCredential) {
    await store.upsertCredential({
      id: credentialId,
      userId: user.id,
      publicKeyBase64Url: base64UrlEncode(info.credential.publicKey),
      counter: info.credential.counter,
      transports: (credential.response?.transports as string[] | undefined) ?? undefined,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp ?? false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  return await createUserSessionResponse(settings, store, req, user);
}

async function handleLoginOptions(settings: Settings, store: KvStore, req: Request): Promise<Response> {
  if (settings.authMode !== "passkey") {
    return jsonWithCors(settings, req, { error: "Passkey flow is disabled. Use AUTH_MODE=basic." }, 400);
  }

  const origin = req.headers.get("origin");
  if (!isOriginAllowed(settings, origin)) {
    return jsonWithCors(settings, req, { error: "Origin not allowed." }, 403);
  }

  const body = await parseJson(req);
  const username = asString(body?.username);
  if (!username) {
    return jsonWithCors(settings, req, { error: "Username is required." }, 400);
  }

  const user = await store.getUserByName(username);
  if (!user) {
    return jsonWithCors(settings, req, { error: "Invalid credentials." }, 400);
  }

  const credentials = await store.listCredentials(user.id);
  if (credentials.length === 0) {
    return jsonWithCors(settings, req, { error: "Invalid credentials." }, 400);
  }

  const rpId = resolveRpId(settings, origin!);
  const options = await generateAuthenticationOptions({
    rpID: rpId,
    timeout: settings.challengeTtlSec * 1000,
    allowCredentials: credentials.map((credential) => ({
      id: credential.id,
      transports: credential.transports as AuthenticatorTransportFuture[] | undefined,
    })),
    userVerification: "required",
  });

  await store.setChallenge({
    challenge: options.challenge,
    kind: "authentication",
    userId: user.id,
    pendingName: null,
    pendingDisplayName: null,
    expiresAt: Date.now() + settings.challengeTtlSec * 1000,
    createdAt: Date.now(),
  });

  return jsonWithCors(settings, req, options, 200);
}

async function handleLoginVerify(settings: Settings, store: KvStore, req: Request): Promise<Response> {
  if (settings.authMode !== "passkey") {
    return jsonWithCors(settings, req, { error: "Passkey flow is disabled. Use AUTH_MODE=basic." }, 400);
  }

  const origin = req.headers.get("origin");
  if (!isOriginAllowed(settings, origin)) {
    return jsonWithCors(settings, req, { error: "Origin not allowed." }, 403);
  }

  const body = await parseJson(req);
  const credential = body?.credential as AuthenticationResponseJSON | undefined;
  if (!credential || typeof credential !== "object") {
    return jsonWithCors(settings, req, { error: "Invalid payload." }, 400);
  }

  const stored = await store.getCredential(credential.id);
  if (!stored) {
    return jsonWithCors(settings, req, { error: "Unknown credential." }, 400);
  }

  const user = await store.getUserById(stored.userId);
  if (!user) {
    return jsonWithCors(settings, req, { error: "User not found." }, 404);
  }

  const challenge = extractChallengeFromClientData(credential.response?.clientDataJSON);
  if (!challenge) {
    return jsonWithCors(settings, req, { error: "Malformed clientDataJSON." }, 400);
  }

  const challengeRecord = await store.consumeChallenge(challenge, "authentication");
  if (!challengeRecord) {
    return jsonWithCors(settings, req, { error: "Authentication challenge expired." }, 400);
  }

  if (challengeRecord.userId && challengeRecord.userId !== user.id) {
    return jsonWithCors(settings, req, { error: "Challenge/user mismatch." }, 400);
  }

  const rpId = resolveRpId(settings, origin!);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: challengeRecord.challenge,
      expectedOrigin: origin!,
      expectedRPID: rpId,
      requireUserVerification: true,
      credential: {
        id: stored.id,
        publicKey: base64UrlDecode(stored.publicKeyBase64Url),
        counter: stored.counter,
        transports: stored.transports as AuthenticatorTransportFuture[] | undefined,
      },
    });
  } catch {
    return jsonWithCors(settings, req, { error: "Authentication verification failed." }, 400);
  }

  if (!verification.verified || !verification.authenticationInfo) {
    return jsonWithCors(settings, req, { error: "Authentication not verified." }, 400);
  }

  await store.updateCredentialCounter(stored.id, verification.authenticationInfo.newCounter);
  return await createUserSessionResponse(settings, store, req, user);
}

async function handleRefresh(settings: Settings, store: KvStore, req: Request): Promise<Response> {
  const body = await parseJson(req);
  const refreshToken = asString(body?.refreshToken);
  if (!refreshToken) {
    return jsonWithCors(settings, req, { error: "refreshToken is required." }, 400);
  }

  const rotated = await store.rotateWebRefresh(refreshToken);
  if (!rotated) {
    return jsonWithCors(settings, req, { error: "Invalid or expired refresh token." }, 401);
  }

  const user = await store.getUserById(rotated.session.userId);
  if (!user) {
    return jsonWithCors(settings, req, { error: "User not found." }, 404);
  }

  const token = await createWebSessionToken(settings, user, rotated.session.id);
  return jsonWithCors(settings, req, {
    token,
    refreshToken: rotated.refreshToken,
    user: { id: user.id, name: user.name },
  });
}

async function handleLogout(settings: Settings, store: KvStore, req: Request): Promise<Response> {
  const token = getRequestToken(req);
  if (token) {
    const payload = await verifyWebToken(settings, store, token);
    if (payload?.jti) {
      await store.revokeWebSession(payload.jti);
    }
  }
  return emptyWithCors(settings, req, 204);
}

async function handleDeviceCode(settings: Settings, store: KvStore, req: Request): Promise<Response> {
  for (let i = 0; i < 8; i += 1) {
    const userCode = randomId(8)
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 8)
      .toUpperCase();
    const formattedUserCode = `${userCode.slice(0, 4)}-${userCode.slice(4)}`;
    const deviceCode = randomId(24);

    try {
      const record = await store.createDeviceCode(deviceCode, formattedUserCode);
      return jsonWithCors(settings, req, {
        deviceCode: record.deviceCode,
        userCode: record.userCode,
        verificationUrl: getDeviceVerificationUrl(settings, req),
        expiresIn: settings.deviceCodeTtlSec,
        interval: settings.devicePollIntervalSec,
      });
    } catch {
      // retry
    }
  }

  return jsonWithCors(settings, req, { error: "Failed to create device code." }, 500);
}

async function handleDeviceAuthorise(settings: Settings, store: KvStore, req: Request): Promise<Response> {
  const user = await getAuthenticatedUser(settings, store, req);
  if (!user) {
    return jsonWithCors(settings, req, { error: "Authentication required." }, 401);
  }

  const body = await parseJson(req);
  const userCode = asString(body?.userCode)?.toUpperCase();
  if (!userCode) {
    return jsonWithCors(settings, req, { error: "userCode is required." }, 400);
  }

  const ok = await store.authoriseDeviceCode(userCode, user.id);
  if (!ok) {
    return jsonWithCors(settings, req, { error: "Code expired or not found." }, 400);
  }

  return jsonWithCors(settings, req, { ok: true }, 200);
}

async function handleDeviceToken(settings: Settings, store: KvStore, req: Request): Promise<Response> {
  const body = await parseJson(req);
  const deviceCode = asString(body?.deviceCode);
  if (!deviceCode) {
    return jsonWithCors(settings, req, { error: "deviceCode is required." }, 400);
  }

  const pending = await store.getDeviceCode(deviceCode);
  if (!pending) {
    return jsonWithCors(settings, req, { status: "expired" }, 200);
  }

  if (pending.status === "pending") {
    return jsonWithCors(settings, req, { status: "pending" }, 200);
  }

  const consumed = await store.consumeAuthorisedDeviceCode(deviceCode);
  if (!consumed || !consumed.userId) {
    return jsonWithCors(settings, req, { status: "expired" }, 200);
  }

  const anchor = await store.createAnchorSession(consumed.userId);
  return jsonWithCors(settings, req, {
    status: "authorised",
    userId: consumed.userId,
    anchorAccessToken: anchor.accessToken,
    anchorRefreshToken: anchor.refreshToken,
    anchorAccessExpiresIn: Math.max(anchor.session.accessExpiresAt - nowSec(), 0),
  });
}

async function handleDeviceRefresh(settings: Settings, store: KvStore, req: Request): Promise<Response> {
  const body = await parseJson(req);
  const refreshToken = asString(body?.refreshToken);
  if (!refreshToken) {
    return jsonWithCors(settings, req, { error: "refreshToken is required." }, 400);
  }

  const rotated = await store.rotateAnchorRefresh(refreshToken);
  if (!rotated) {
    return jsonWithCors(settings, req, { error: "Invalid or expired refresh token." }, 401);
  }

  return jsonWithCors(settings, req, {
    anchorAccessToken: rotated.accessToken,
    anchorRefreshToken: rotated.refreshToken,
    anchorAccessExpiresIn: Math.max(rotated.session.accessExpiresAt - nowSec(), 0),
  });
}

function unsupportedTotp(settings: Settings, req: Request): Response {
  return jsonWithCors(settings, req, { error: "TOTP endpoints are not available on deno provider yet." }, 400);
}

export async function handleAuthRequest(settings: Settings, store: KvStore, req: Request, pathname: string): Promise<Response> {
  if (req.method === "OPTIONS") {
    return jsonWithCors(settings, req, {}, 204);
  }

  if (pathname === "/auth/session" && req.method === "GET") return await handleSession(settings, store, req);
  if (pathname === "/auth/register/basic" && req.method === "POST") return await handleRegisterBasic(settings, store, req);
  if (pathname === "/auth/login/basic" && req.method === "POST") return await handleLoginBasic(settings, store, req);
  if (pathname === "/auth/register/options" && req.method === "POST") return await handleRegisterOptions(settings, store, req);
  if (pathname === "/auth/register/verify" && req.method === "POST") return await handleRegisterVerify(settings, store, req);
  if (pathname === "/auth/login/options" && req.method === "POST") return await handleLoginOptions(settings, store, req);
  if (pathname === "/auth/login/verify" && req.method === "POST") return await handleLoginVerify(settings, store, req);
  if (pathname === "/auth/refresh" && req.method === "POST") return await handleRefresh(settings, store, req);
  if (pathname === "/auth/logout" && req.method === "POST") return await handleLogout(settings, store, req);
  if (pathname === "/auth/device/code" && req.method === "POST") return await handleDeviceCode(settings, store, req);
  if (pathname === "/auth/device/authorise" && req.method === "POST") return await handleDeviceAuthorise(settings, store, req);
  if (pathname === "/auth/device/token" && req.method === "POST") return await handleDeviceToken(settings, store, req);
  if (pathname === "/auth/device/refresh" && req.method === "POST") return await handleDeviceRefresh(settings, store, req);

  if (
    pathname === "/auth/register/totp/start" ||
    pathname === "/auth/register/totp/verify" ||
    pathname === "/auth/login/totp" ||
    pathname === "/auth/totp/setup/options" ||
    pathname === "/auth/totp/setup/verify"
  ) {
    return unsupportedTotp(settings, req);
  }

  return jsonWithCors(settings, req, { error: "Not found" }, 404);
}

export async function authorizeWsRequest(
  settings: Settings,
  store: KvStore,
  req: Request,
  role: "client" | "anchor",
): Promise<{ userId: string } | null> {
  const token = getRequestToken(req);
  if (!token) return null;

  if (role === "client") {
    const payload = await verifyWebToken(settings, store, token);
    if (!payload) return null;
    return { userId: payload.sub };
  }

  const payload = await verifyAnchorAnyToken(settings, store, token);
  if (!payload) return null;
  return { userId: payload.sub };
}
