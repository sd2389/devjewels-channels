-- App-launch lookup: pending invite by shop (GET / hmac + shop).
-- Apply-safe. Bounded query uses lower(shop_domain) + created_at DESC LIMIT 1.

CREATE INDEX IF NOT EXISTS shopify_connect_invite_shop_pending_idx
  ON channels.shopify_connect_invite (lower(shop_domain), created_at DESC)
  WHERE consumed_at IS NULL;
