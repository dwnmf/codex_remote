-- TOTP second factor
CREATE TABLE IF NOT EXISTS totp_factors (
  user_id TEXT PRIMARY KEY,
  secret_base32 TEXT NOT NULL,
  digits INTEGER NOT NULL DEFAULT 6,
  period_sec INTEGER NOT NULL DEFAULT 30,
  algorithm TEXT NOT NULL DEFAULT 'SHA1',
  last_used_step INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES passkey_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_totp_factors_user ON totp_factors(user_id);
