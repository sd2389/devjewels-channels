-- Local seed example for Shopify inventory path (schema channels only).
-- Apply after 001_channels_schema.sql + apps/shopify/src/db/001_shopify_tables.sql.
--
-- 1) Put credentials in env (never in SQL):
--    export CHANNELS_SECRET_shopify_local='{"accessToken":"shpat_TEST","shopDomain":"devjewels-test.myshopify.com"}'
-- 2) connection.credentials_secret_ref = 'env:CHANNELS_SECRET_shopify_local'
-- 3) Replace UUIDs / design_no / job_no / Shopify GIDs with real values.

BEGIN;

INSERT INTO channels.connection (
  id, platform, name, credentials_secret_ref,
  sync_inventory, sync_price, sync_products, sync_orders, is_active
) VALUES (
  '11111111-1111-1111-1111-111111111111',
  'SHOPIFY',
  'Local Shopify test',
  'env:CHANNELS_SECRET_shopify_local',
  TRUE, TRUE, TRUE, TRUE, TRUE
) ON CONFLICT (id) DO UPDATE
  SET credentials_secret_ref = EXCLUDED.credentials_secret_ref,
      is_active = TRUE,
      sync_inventory = TRUE,
      sync_products = TRUE,
      updated_at = now();

INSERT INTO channels.shopify_connection (connection_id, shop_domain)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  'devjewels-test.myshopify.com'
) ON CONFLICT (connection_id) DO UPDATE
  SET shop_domain = EXCLUDED.shop_domain, updated_at = now();

INSERT INTO channels.shopify_location (
  connection_id, external_location_id, name, is_primary
) VALUES (
  '11111111-1111-1111-1111-111111111111',
  'gid://shopify/Location/1',
  'Primary',
  TRUE
) ON CONFLICT (connection_id, external_location_id) DO UPDATE
  SET is_primary = TRUE, name = EXCLUDED.name;

INSERT INTO channels.variant_mapping (
  connection_id, design_no, job_no,
  external_variant_id, external_inventory_item_id
) VALUES (
  '11111111-1111-1111-1111-111111111111',
  'SC-1',
  'JOB-1',
  'gid://shopify/ProductVariant/1',
  'gid://shopify/InventoryItem/1'
) ON CONFLICT (connection_id, design_no, job_no) DO UPDATE
  SET external_variant_id = EXCLUDED.external_variant_id,
      external_inventory_item_id = EXCLUDED.external_inventory_item_id,
      updated_at = now();

COMMIT;
