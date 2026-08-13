-- Shopify-owned tables in schema channels (platform prefix shopify_*).
-- Same Postgres database as DevJewels; schema channels only (no separate DB).
-- Core owns shared tables; this app owns only shopify_* migrations.
-- Do not add Shopify-only columns to channels.connection.
-- Tokens live in secret refs (env:/sm:), never plaintext in these tables.

CREATE TABLE IF NOT EXISTS channels.shopify_connection (
  connection_id   UUID PRIMARY KEY REFERENCES channels.connection (id) ON DELETE CASCADE,
  shop_domain     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One connection per shop (case-insensitive). Concurrent connect races fail closed.
CREATE UNIQUE INDEX IF NOT EXISTS shopify_connection_shop_domain_lower_uidx
  ON channels.shopify_connection (lower(shop_domain));

CREATE TABLE IF NOT EXISTS channels.shopify_oauth_state (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id   UUID REFERENCES channels.connection (id) ON DELETE CASCADE,
  shop_domain     TEXT NOT NULL,
  state           TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channels.shopify_location (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id     UUID NOT NULL REFERENCES channels.connection (id) ON DELETE CASCADE,
  external_location_id TEXT NOT NULL,
  name              TEXT,
  is_primary        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_location_id)
);

CREATE TABLE IF NOT EXISTS channels.shopify_webhook_subscription (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id     UUID NOT NULL REFERENCES channels.connection (id) ON DELETE CASCADE,
  topic             TEXT NOT NULL,
  external_webhook_id TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, topic)
);

CREATE TABLE IF NOT EXISTS channels.shopify_rate_limit_state (
  connection_id     UUID PRIMARY KEY REFERENCES channels.connection (id) ON DELETE CASCADE,
  currently_available INTEGER,
  restore_rate      NUMERIC,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
