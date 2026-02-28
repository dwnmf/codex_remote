import type {
  AnchorSessionRecord,
  ChallengeRecord,
  DeviceCodeRecord,
  PasskeyCredentialRecord,
  Settings,
  TotpFactorRecord,
  UserRecord,
  WebSessionRecord,
} from "./types.ts";
import { lower, nowSec, randomId, sha256Base64Url } from "./utils.ts";

function kvUserByIdKey(userId: string): Deno.KvKey {
  return ["users", "by-id", userId];
}

function kvUserByNameKey(name: string): Deno.KvKey {
  return ["users", "by-name", lower(name)];
}

function kvCredentialByIdKey(credentialId: string): Deno.KvKey {
  return ["passkeys", "by-id", credentialId];
}

function kvCredentialByUserKey(userId: string, credentialId: string): Deno.KvKey {
  return ["passkeys", "by-user", userId, credentialId];
}

function kvSessionKey(sessionId: string): Deno.KvKey {
  return ["sessions", sessionId];
}

function kvSessionRefreshKey(refreshHash: string): Deno.KvKey {
  return ["sessions", "by-refresh", refreshHash];
}

function kvChallengeKey(challenge: string): Deno.KvKey {
  return ["challenges", challenge];
}

function kvDeviceByDeviceCodeKey(deviceCode: string): Deno.KvKey {
  return ["device-codes", "by-device", deviceCode];
}

function kvDeviceByUserCodeKey(userCode: string): Deno.KvKey {
  return ["device-codes", "by-user", userCode];
}

function kvAnchorSessionKey(sessionId: string): Deno.KvKey {
  return ["anchor-sessions", sessionId];
}

function kvAnchorAccessKey(accessHash: string): Deno.KvKey {
  return ["anchor-sessions", "by-access", accessHash];
}

function kvAnchorRefreshKey(refreshHash: string): Deno.KvKey {
  return ["anchor-sessions", "by-refresh", refreshHash];
}

function kvTotpFactorByUserKey(userId: string): Deno.KvKey {
  return ["totp", "by-user", userId];
}

export class KvStore {
  constructor(
    private readonly database: Deno.Kv,
    private readonly settings: Settings,
  ) {}

  async hasAnyUsers(): Promise<boolean> {
    for await (const _ of this.database.list<UserRecord>({ prefix: ["users", "by-id"] }, { limit: 1 })) {
      return true;
    }
    return false;
  }

  async getUserById(userId: string): Promise<UserRecord | null> {
    const entry = await this.database.get<UserRecord>(kvUserByIdKey(userId));
    return entry.value ?? null;
  }

  async getUserByName(name: string): Promise<UserRecord | null> {
    const indexEntry = await this.database.get<string>(kvUserByNameKey(name));
    if (!indexEntry.value) return null;
    return await this.getUserById(indexEntry.value);
  }

  async createUser(name: string, displayName: string): Promise<UserRecord | null> {
    const cleanName = name.trim();
    const userId = randomId(16);
    const user: UserRecord = {
      id: userId,
      name: cleanName,
      displayName: displayName.trim() || cleanName,
      createdAt: Date.now(),
    };

    const existing = await this.database.get<string>(kvUserByNameKey(cleanName));
    if (existing.value) {
      return null;
    }

    const committed = await this.database
      .atomic()
      .check(existing)
      .set(kvUserByNameKey(cleanName), userId)
      .set(kvUserByIdKey(userId), user)
      .commit();

    return committed.ok ? user : null;
  }

  async listCredentials(userId: string): Promise<PasskeyCredentialRecord[]> {
    const credentials: PasskeyCredentialRecord[] = [];
    for await (const entry of this.database.list<PasskeyCredentialRecord>({ prefix: ["passkeys", "by-user", userId] })) {
      if (!entry.value) continue;
      credentials.push(entry.value);
    }
    credentials.sort((a, b) => a.createdAt - b.createdAt);
    return credentials;
  }

  async getCredential(credentialId: string): Promise<PasskeyCredentialRecord | null> {
    const entry = await this.database.get<PasskeyCredentialRecord>(kvCredentialByIdKey(credentialId));
    return entry.value ?? null;
  }

  async upsertCredential(credential: PasskeyCredentialRecord): Promise<void> {
    await this.database
      .atomic()
      .set(kvCredentialByIdKey(credential.id), credential)
      .set(kvCredentialByUserKey(credential.userId, credential.id), credential)
      .commit();
  }

  async updateCredentialCounter(credentialId: string, counter: number): Promise<void> {
    const current = await this.getCredential(credentialId);
    if (!current) return;
    const updated: PasskeyCredentialRecord = {
      ...current,
      counter,
      updatedAt: Date.now(),
    };
    await this.upsertCredential(updated);
  }

  async getTotpFactorByUserId(userId: string): Promise<TotpFactorRecord | null> {
    const entry = await this.database.get<TotpFactorRecord>(kvTotpFactorByUserKey(userId));
    return entry.value ?? null;
  }

  async upsertTotpFactor(
    factor: Omit<TotpFactorRecord, "createdAt" | "updatedAt"> & { createdAt?: number; updatedAt?: number },
  ): Promise<void> {
    const existing = await this.getTotpFactorByUserId(factor.userId);
    const now = Date.now();
    const next: TotpFactorRecord = {
      ...factor,
      createdAt: existing?.createdAt ?? factor.createdAt ?? now,
      updatedAt: factor.updatedAt ?? now,
    };
    await this.database.set(kvTotpFactorByUserKey(factor.userId), next);
  }

  async consumeTotpStep(userId: string, step: number): Promise<boolean> {
    const key = kvTotpFactorByUserKey(userId);
    const entry = await this.database.get<TotpFactorRecord>(key);
    if (!entry.value) return false;

    const current = entry.value;
    if (current.lastUsedStep != null && current.lastUsedStep >= step) {
      return false;
    }

    const updated: TotpFactorRecord = {
      ...current,
      lastUsedStep: step,
      updatedAt: Date.now(),
    };

    const committed = await this.database.atomic().check(entry).set(key, updated).commit();
    return committed.ok;
  }

  async createWebSession(userId: string): Promise<{ session: WebSessionRecord; refreshToken: string }> {
    const now = nowSec();
    const sessionId = randomId(16);
    const refreshToken = randomId(32);
    const refreshHash = await sha256Base64Url(refreshToken);
    const session: WebSessionRecord = {
      id: sessionId,
      userId,
      createdAt: now,
      expiresAt: now + this.settings.accessTtlSec,
      revokedAt: null,
      refreshTokenHash: refreshHash,
      refreshExpiresAt: now + this.settings.refreshTtlSec,
    };

    await this.database
      .atomic()
      .set(kvSessionKey(sessionId), session)
      .set(kvSessionRefreshKey(refreshHash), sessionId)
      .commit();

    return { session, refreshToken };
  }

  async getActiveWebSession(sessionId: string): Promise<WebSessionRecord | null> {
    const entry = await this.database.get<WebSessionRecord>(kvSessionKey(sessionId));
    const session = entry.value;
    if (!session) return null;
    if (session.revokedAt || session.expiresAt <= nowSec()) return null;
    return session;
  }

  async revokeWebSession(sessionId: string): Promise<void> {
    const entry = await this.database.get<WebSessionRecord>(kvSessionKey(sessionId));
    if (!entry.value || entry.value.revokedAt) return;

    const revoked: WebSessionRecord = { ...entry.value, revokedAt: nowSec() };
    await this.database
      .atomic()
      .check(entry)
      .set(kvSessionKey(sessionId), revoked)
      .delete(kvSessionRefreshKey(entry.value.refreshTokenHash))
      .commit();
  }

  async rotateWebRefresh(refreshToken: string): Promise<{ session: WebSessionRecord; refreshToken: string } | null> {
    const refreshHash = await sha256Base64Url(refreshToken);
    const refreshEntry = await this.database.get<string>(kvSessionRefreshKey(refreshHash));
    if (!refreshEntry.value) return null;

    const sessionEntry = await this.database.get<WebSessionRecord>(kvSessionKey(refreshEntry.value));
    if (!sessionEntry.value) return null;

    const session = sessionEntry.value;
    const now = nowSec();
    if (session.revokedAt || session.refreshExpiresAt <= now) return null;

    const revoked: WebSessionRecord = { ...session, revokedAt: now };
    const consumed = await this.database
      .atomic()
      .check(refreshEntry)
      .check(sessionEntry)
      .set(kvSessionKey(session.id), revoked)
      .delete(kvSessionRefreshKey(refreshHash))
      .commit();

    if (!consumed.ok) return null;
    return await this.createWebSession(session.userId);
  }

  async setChallenge(record: ChallengeRecord): Promise<void> {
    const ttlMs = Math.max(record.expiresAt - Date.now(), 1000);
    await this.database.set(kvChallengeKey(record.challenge), record, { expireIn: ttlMs });
  }

  async consumeChallenge(challenge: string, kind: "registration" | "authentication"): Promise<ChallengeRecord | null> {
    const entry = await this.database.get<ChallengeRecord>(kvChallengeKey(challenge));
    if (!entry.value) return null;

    const record = entry.value;
    const deleted = await this.database.atomic().check(entry).delete(kvChallengeKey(challenge)).commit();
    if (!deleted.ok) return null;
    if (record.expiresAt <= Date.now()) return null;
    if (record.kind !== kind) return null;
    return record;
  }

  async createDeviceCode(deviceCode: string, userCode: string): Promise<DeviceCodeRecord> {
    const now = Date.now();
    const record: DeviceCodeRecord = {
      deviceCode,
      userCode,
      status: "pending",
      userId: null,
      expiresAt: now + this.settings.deviceCodeTtlSec * 1000,
      createdAt: now,
    };

    const ttlMs = this.settings.deviceCodeTtlSec * 1000;
    const byUserEntry = await this.database.get<string>(kvDeviceByUserCodeKey(userCode));
    if (byUserEntry.value) {
      throw new Error("user code already exists");
    }

    const committed = await this.database
      .atomic()
      .check(byUserEntry)
      .set(kvDeviceByDeviceCodeKey(deviceCode), record, { expireIn: ttlMs })
      .set(kvDeviceByUserCodeKey(userCode), deviceCode, { expireIn: ttlMs })
      .commit();

    if (!committed.ok) {
      throw new Error("failed to create device code");
    }

    return record;
  }

  async getDeviceCode(deviceCode: string): Promise<DeviceCodeRecord | null> {
    const entry = await this.database.get<DeviceCodeRecord>(kvDeviceByDeviceCodeKey(deviceCode));
    if (!entry.value) return null;
    if (entry.value.expiresAt <= Date.now()) return null;
    return entry.value;
  }

  async authoriseDeviceCode(userCode: string, userId: string): Promise<boolean> {
    const userCodeKey = kvDeviceByUserCodeKey(userCode);
    const userRef = await this.database.get<string>(userCodeKey);
    if (!userRef.value) return false;

    const recordKey = kvDeviceByDeviceCodeKey(userRef.value);
    const recordEntry = await this.database.get<DeviceCodeRecord>(recordKey);
    if (!recordEntry.value) return false;

    if (recordEntry.value.expiresAt <= Date.now()) return false;

    const updated: DeviceCodeRecord = {
      ...recordEntry.value,
      status: "authorised",
      userId,
    };

    const ttlMs = Math.max(updated.expiresAt - Date.now(), 1000);
    const committed = await this.database
      .atomic()
      .check(userRef)
      .check(recordEntry)
      .set(recordKey, updated, { expireIn: ttlMs })
      .set(userCodeKey, updated.deviceCode, { expireIn: ttlMs })
      .commit();

    return committed.ok;
  }

  async consumeAuthorisedDeviceCode(deviceCode: string): Promise<DeviceCodeRecord | null> {
    const recordKey = kvDeviceByDeviceCodeKey(deviceCode);
    const recordEntry = await this.database.get<DeviceCodeRecord>(recordKey);
    if (!recordEntry.value) return null;

    const record = recordEntry.value;
    if (record.expiresAt <= Date.now()) return null;
    if (record.status !== "authorised" || !record.userId) return null;

    const committed = await this.database
      .atomic()
      .check(recordEntry)
      .delete(recordKey)
      .delete(kvDeviceByUserCodeKey(record.userCode))
      .commit();

    return committed.ok ? record : null;
  }

  async createAnchorSession(userId: string): Promise<{ session: AnchorSessionRecord; accessToken: string; refreshToken: string }> {
    const now = nowSec();
    const sessionId = randomId(16);
    const accessToken = randomId(32);
    const refreshToken = randomId(32);
    const accessHash = await sha256Base64Url(accessToken);
    const refreshHash = await sha256Base64Url(refreshToken);

    const session: AnchorSessionRecord = {
      id: sessionId,
      userId,
      accessTokenHash: accessHash,
      accessExpiresAt: now + this.settings.anchorAccessTtlSec,
      refreshTokenHash: refreshHash,
      refreshExpiresAt: now + this.settings.anchorRefreshTtlSec,
      revokedAt: null,
      createdAt: now,
    };

    await this.database
      .atomic()
      .set(kvAnchorSessionKey(sessionId), session)
      .set(kvAnchorAccessKey(accessHash), sessionId)
      .set(kvAnchorRefreshKey(refreshHash), sessionId)
      .commit();

    return { session, accessToken, refreshToken };
  }

  async verifyAnchorAccessToken(accessToken: string): Promise<AnchorSessionRecord | null> {
    const accessHash = await sha256Base64Url(accessToken);
    const accessEntry = await this.database.get<string>(kvAnchorAccessKey(accessHash));
    if (!accessEntry.value) return null;

    const sessionEntry = await this.database.get<AnchorSessionRecord>(kvAnchorSessionKey(accessEntry.value));
    if (!sessionEntry.value) return null;

    if (sessionEntry.value.revokedAt || sessionEntry.value.accessExpiresAt <= nowSec()) return null;
    return sessionEntry.value;
  }

  async rotateAnchorRefresh(refreshToken: string): Promise<{ session: AnchorSessionRecord; accessToken: string; refreshToken: string } | null> {
    const refreshHash = await sha256Base64Url(refreshToken);
    const refreshEntry = await this.database.get<string>(kvAnchorRefreshKey(refreshHash));
    if (!refreshEntry.value) return null;

    const sessionEntry = await this.database.get<AnchorSessionRecord>(kvAnchorSessionKey(refreshEntry.value));
    if (!sessionEntry.value) return null;

    const session = sessionEntry.value;
    const now = nowSec();
    if (session.revokedAt || session.refreshExpiresAt <= now) return null;

    const revoked: AnchorSessionRecord = { ...session, revokedAt: now };
    const consumed = await this.database
      .atomic()
      .check(refreshEntry)
      .check(sessionEntry)
      .set(kvAnchorSessionKey(session.id), revoked)
      .delete(kvAnchorAccessKey(session.accessTokenHash))
      .delete(kvAnchorRefreshKey(refreshHash))
      .commit();

    if (!consumed.ok) return null;
    return await this.createAnchorSession(session.userId);
  }
}
