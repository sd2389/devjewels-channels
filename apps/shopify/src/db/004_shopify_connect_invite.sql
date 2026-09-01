-- Single-use Shopify connect invite tokens (staff-generated share links).
-- Tokens are HMAC-signed; jti is the DB anchor for one-time redemption.

CREATE TABLE IF NOT EXISTS channels.shopify_connect_invite (
  jti           UUID PRIMARY KEY,
  customer_id   INTEGER NOT NULL,
  shop_domain   TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shopify_connect_invite_customer_idx
  ON channels.shopify_connect_invite (customer_id);

CREATE INDEX IF NOT EXISTS shopify_connect_invite_expires_idx
  ON channels.shopify_connect_invite (expires_at)
  WHERE consumed_at IS NULL;
