export interface AuthEnv {
  DB: D1Database;
  PASSKEY_CHALLENGE_DO: DurableObjectNamespace;
  PASSKEY_ORIGIN?: string;
  CODEX_REMOTE_WEB_JWT_SECRET?: string;
  CODEX_REMOTE_ANCHOR_JWT_SECRET?: string;
}
