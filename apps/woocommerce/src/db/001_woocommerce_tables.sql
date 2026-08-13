-- WooCommerce-owned tables (schema channels, prefix woocommerce_*).
-- Same Postgres database as DevJewels; schema channels only (no separate DB).
-- Phase 3: add tables when adapter is implemented.
-- Placeholder — no CREATE TABLE yet; keep ownership obvious.

-- Examples (create only as needed):
--   channels.woocommerce_oauth_state
--   channels.woocommerce_webhook_key
--
-- Do not put Woo-only columns on shared channels.connection.

SELECT 1; -- no-op stub so the migration file is valid SQL
