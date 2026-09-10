-- Durable vault for operator + connection secrets (Lambda filesystem is read-only).
-- connection.credentials_secret_ref stays vault:<id>; payload is never logged.
-- Safe to re-run (IF NOT EXISTS).
--
--   psql "$DATABASE_URL" -f apps/core/src/db/shared/004_vault_secret.sql

CREATE TABLE IF NOT EXISTS channels.vault_secret (
  id          TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
