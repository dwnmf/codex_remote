export type Role = "client" | "anchor";
export type AuthMode = "passkey" | "basic";

export interface Settings {
  authMode: AuthMode;
  webJwtSecret: string;
  anchorJwtSecret: string;
  accessTtlSec: number;
  refreshTtlSec: number;
  corsOrigins: string[];
  deviceCodeTtlSec: number;
  devicePollIntervalSec: number;
  deviceVerificationUrl: string;
  challengeTtlSec: number;
  passkeyOrigin: string;
  passkeyRpId: string;
  anchorAccessTtlSec: number;
  anchorRefreshTtlSec: number;
}

export interface UserRecord {
  id: string;
  name: string;
  displayName: string;
  createdAt: number;
}

export interface WebSessionRecord {
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  refreshTokenHash: string;
  refreshExpiresAt: number;
}

export interface DeviceCodeRecord {
  deviceCode: string;
  userCode: string;
  status: "pending" | "authorised";
  userId: string | null;
  expiresAt: number;
  createdAt: number;
}

export interface ChallengeRecord {
  challenge: string;
  kind: "registration" | "authentication";
  userId: string | null;
  pendingName: string | null;
  pendingDisplayName: string | null;
  expiresAt: number;
  createdAt: number;
}

export interface PasskeyCredentialRecord {
  id: string;
  userId: string;
  publicKeyBase64Url: string;
  counter: number;
  transports: string[] | undefined;
  deviceType: string | undefined;
  backedUp: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AnchorSessionRecord {
  id: string;
  userId: string;
  accessTokenHash: string;
  accessExpiresAt: number;
  refreshTokenHash: string;
  refreshExpiresAt: number;
  revokedAt: number | null;
  createdAt: number;
}

export interface SessionPayload {
  sub: string;
  name: string;
  jti: string;
}
