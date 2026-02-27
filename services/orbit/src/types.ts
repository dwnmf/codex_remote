export type Role = "client" | "anchor";
export type Direction = "client" | "server";

export interface Env {
  CODEX_REMOTE_WEB_JWT_SECRET?: string;
  CODEX_REMOTE_ANCHOR_JWT_SECRET?: string;
  PASSKEY_ORIGIN?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  ALLOWED_ORIGIN?: string;
  DB: D1Database;
  ORBIT_DO: DurableObjectNamespace;
  PASSKEY_CHALLENGE_DO: DurableObjectNamespace;
}

export interface AuthResult {
  authorised: boolean;
  userId: string | null;
  jwtType: "web" | "anchor" | null;
}
