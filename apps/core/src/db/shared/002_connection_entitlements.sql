-- Entitlement-scoped connections: customer_id + markup_mode/value
-- Safe to re-run (IF NOT EXISTS).

ALTER TABLE channels.connection
  ADD COLUMN IF NOT EXISTS customer_id INTEGER;

ALTER TABLE channels.connection
  ADD COLUMN IF NOT EXISTS markup_mode TEXT NOT NULL DEFAULT 'none';

ALTER TABLE channels.connection
  ADD COLUMN IF NOT EXISTS markup_value NUMERIC(12, 4) NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS connection_customer_id_unique_idx
  ON channels.connection (customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS connection_customer_id_idx
  ON channels.connection (customer_id)
  WHERE customer_id IS NOT NULL;
