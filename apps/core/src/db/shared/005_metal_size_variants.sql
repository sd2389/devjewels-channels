-- Per-connection catalog layout + the Metal × Size variant slots behind it.
--
-- variant_layout:
--   'piece'      — one Shopify variant per stock piece (job_no). The default.
--   'metal_size' — one variant per Metal × Size, every 14K colour and ring
--                  size listed; the cheapest live piece of the combination is
--                  the one sold, combinations with no piece are sold out.
-- sync_product_description: write the live stock table into descriptionHtml
--   (and nothing else of the product's content).
--
-- Apply BEFORE deploying code that selects these columns.
-- Safe to re-run (IF NOT EXISTS).
--
--   psql "$DATABASE_URL" -f apps/core/src/db/shared/005_metal_size_variants.sql

ALTER TABLE channels.connection
  ADD COLUMN IF NOT EXISTS variant_layout TEXT NOT NULL DEFAULT 'piece';

ALTER TABLE channels.connection
  ADD COLUMN IF NOT EXISTS sync_product_description BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'connection_variant_layout_check'
  ) THEN
    ALTER TABLE channels.connection
      ADD CONSTRAINT connection_variant_layout_check
      CHECK (variant_layout IN ('piece', 'metal_size'));
  END IF;
END $$;

-- One row per Metal × Size variant. job_nos holds the live pieces of the
-- combination cheapest first; job_nos[1] is the piece an order reserves.
CREATE TABLE IF NOT EXISTS channels.variant_slot (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id               UUID NOT NULL REFERENCES channels.connection (id) ON DELETE CASCADE,
  design_no                   TEXT NOT NULL,
  slot_key                    TEXT NOT NULL,
  sku                         TEXT NOT NULL,
  external_variant_id         TEXT NOT NULL,
  external_inventory_item_id  TEXT,
  job_nos                     TEXT[] NOT NULL DEFAULT '{}',
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, design_no, slot_key)
);

CREATE INDEX IF NOT EXISTS variant_slot_external_variant_idx
  ON channels.variant_slot (connection_id, external_variant_id);

CREATE INDEX IF NOT EXISTS variant_slot_sku_idx
  ON channels.variant_slot (connection_id, sku);
