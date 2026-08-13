-- Apply-safe: unique shop_domain on channels.shopify_connection (case-insensitive).
-- Safe to re-run (IF NOT EXISTS). Fails if duplicate lower(shop_domain) rows already exist —
-- dedupe those rows before applying.
--
-- Usage (shared DevJewels Postgres):
--   psql "$DATABASE_URL" -f apps/shopify/src/db/003_shopify_shop_domain_unique.sql
-- If permission denied: run as table owner / superuser, then GRANT as needed.

CREATE UNIQUE INDEX IF NOT EXISTS shopify_connection_shop_domain_lower_uidx
  ON channels.shopify_connection (lower(shop_domain));
