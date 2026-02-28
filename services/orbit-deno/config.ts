import type { AuthMode, Settings } from "./types.ts";

function getEnv(name: string, fallback = ""): string {
  return (Deno.env.get(name) ?? fallback).trim();
}

function parseIntEnv(name: string, fallback: number, min: number): number {
  const raw = getEnv(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(parsed, min);
}

function parseOrigins(raw: string): string[] {
  const values = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return values.length > 0 ? values : ["*"];
}

export function loadSettings(): Settings {
  const modeRaw = getEnv("AUTH_MODE", "passkey").toLowerCase();
  const authMode: AuthMode = modeRaw === "basic" ? "basic" : "passkey";

  return {
    authMode,
    webJwtSecret: getEnv("CODEX_REMOTE_WEB_JWT_SECRET", "dev-web-secret-change-me"),
    anchorJwtSecret: getEnv("CODEX_REMOTE_ANCHOR_JWT_SECRET", ""),
    accessTtlSec: parseIntEnv("ACCESS_TTL_SEC", 3600, 60),
    refreshTtlSec: parseIntEnv("REFRESH_TTL_SEC", 7 * 24 * 3600, 300),
    corsOrigins: parseOrigins(getEnv("CORS_ORIGINS", "*")),
    deviceCodeTtlSec: parseIntEnv("DEVICE_CODE_TTL_SEC", 600, 60),
    devicePollIntervalSec: parseIntEnv("DEVICE_CODE_POLL_INTERVAL_SEC", 5, 1),
    deviceVerificationUrl: getEnv("DEVICE_VERIFICATION_URL", ""),
    challengeTtlSec: parseIntEnv("CHALLENGE_TTL_SEC", 300, 60),
    passkeyOrigin: getEnv("PASSKEY_ORIGIN", ""),
    passkeyRpId: getEnv("PASSKEY_RP_ID", ""),
    anchorAccessTtlSec: parseIntEnv("ANCHOR_ACCESS_TTL_SEC", 3600, 300),
    anchorRefreshTtlSec: parseIntEnv("ANCHOR_REFRESH_TTL_SEC", 30 * 24 * 3600, 3600),
  };
}
