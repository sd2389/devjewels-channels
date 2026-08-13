-- Schema stub: channels (shared tables)
--
-- HARD RULE (MVP): run against the SAME Postgres database as DevJewels
-- (DB_NAME from backend/.env.example, e.g. local `devjewels`).
-- This creates SCHEMA channels only — never CREATE DATABASE / new RDS for Channels.
-- Role grants: see 000_role_grants.example.sql (channels_app → schema channels only).
-- Apply via migration runner (later). Do not run against production without review.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS channels;

-- After schema exists, ops apply 000_role_grants.example.sql for channels_app.

CREATE TABLE IF NOT EXISTS channels.connection (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform        TEXT NOT NULL CHECK (platform IN ('SHOPIFY', 'WOOCOMMERCE', 'MAGENTO')),
  name            TEXT NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  -- Credentials live in Secrets Manager; store ref only
  credentials_secret_ref TEXT,
  -- Bound DevJewels Customer.pk (1:1 shop ↔ customer for MVP)
  customer_id     INTEGER,
  -- Markup over Customer API / PriceManager price. Default: none (push API price).
  -- markup_mode: none | percent | multiplier
  markup_mode     TEXT NOT NULL DEFAULT 'none'
                  CHECK (markup_mode IN ('none', 'percent', 'multiplier')),
  markup_value    NUMERIC(12, 4) NOT NULL DEFAULT 0,
  -- Legacy basis-points markup (kept for older rows; prefer markup_mode/value)
  markup_bps      INTEGER NOT NULL DEFAULT 0,
  sync_inventory  BOOLEAN NOT NULL DEFAULT TRUE,
  sync_price      BOOLEAN NOT NULL DEFAULT TRUE,
  -- Catalog create/update (title, metafields, variants). Default ON for new connects.
  sync_products   BOOLEAN NOT NULL DEFAULT TRUE,
  sync_orders     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent add for DBs created before sync_products / entitlement columns existed.
ALTER TABLE channels.connection
  ADD COLUMN IF NOT EXISTS sync_products BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE channels.connection
  ADD COLUMN IF NOT EXISTS customer_id INTEGER;
ALTER TABLE channels.connection
  ADD COLUMN IF NOT EXISTS markup_mode TEXT NOT NULL DEFAULT 'none';
ALTER TABLE channels.connection
  ADD COLUMN IF NOT EXISTS markup_value NUMERIC(12, 4) NOT NULL DEFAULT 0;

-- One Shopify shop (connection) per customer for MVP.
CREATE UNIQUE INDEX IF NOT EXISTS connection_customer_id_unique_idx
  ON channels.connection (customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS connection_platform_active_idx
  ON channels.connection (platform, is_active);

CREATE INDEX IF NOT EXISTS connection_customer_id_idx
  ON channels.connection (customer_id)
  WHERE customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS channels.product_mapping (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id     UUID NOT NULL REFERENCES channels.connection (id) ON DELETE CASCADE,
  design_no         TEXT NOT NULL,
  external_product_id TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, design_no)
);

CREATE INDEX IF NOT EXISTS product_mapping_design_idx
  ON channels.product_mapping (design_no);

CREATE TABLE IF NOT EXISTS channels.variant_mapping (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id     UUID NOT NULL REFERENCES channels.connection (id) ON DELETE CASCADE,
  design_no         TEXT NOT NULL,
  job_no            TEXT NOT NULL,
  external_variant_id TEXT NOT NULL,
  external_inventory_item_id TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, design_no, job_no)
);

CREATE INDEX IF NOT EXISTS variant_mapping_job_idx
  ON channels.variant_mapping (job_no);
CREATE INDEX IF NOT EXISTS variant_mapping_design_job_idx
  ON channels.variant_mapping (design_no, job_no);

CREATE TABLE IF NOT EXISTS channels.sync_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id   UUID REFERENCES channels.connection (id) ON DELETE SET NULL,
  platform        TEXT NOT NULL,
  job_type        TEXT NOT NULL, -- inventory | price | product | order
  status          TEXT NOT NULL, -- SUCCESS | FAILED | RETRYING | SKIPPED
  design_no       TEXT,
  job_no          TEXT,
  message         TEXT,
  payload_ref     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sync_log_created_idx
  ON channels.sync_log (created_at DESC);
CREATE INDEX IF NOT EXISTS sync_log_connection_status_idx
  ON channels.sync_log (connection_id, status);

CREATE TABLE IF NOT EXISTS channels.webhook_event (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id       UUID REFERENCES channels.connection (id) ON DELETE SET NULL,
  platform            TEXT NOT NULL,
  external_event_id   TEXT NOT NULL,
  topic               TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'received', -- received | processed | failed
  payload_ref         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, external_event_id)
);

CREATE TABLE IF NOT EXISTS channels.catalog_import (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id   UUID NOT NULL REFERENCES channels.connection (id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | running | completed | failed
  total_designs   INTEGER,
  processed       INTEGER NOT NULL DEFAULT 0,
  error_message   TEXT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS catalog_import_connection_idx
  ON channels.catalog_import (connection_id, created_at DESC);

-- Django → Channels ingest idempotency (shared DB, schema channels only).
CREATE TABLE IF NOT EXISTS channels.ingest_event (
  event_id        TEXT PRIMARY KEY,
  event_type      TEXT NOT NULL,
  occurred_at     TIMESTAMPTZ,
  payload         JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ingest_event_created_idx
  ON channels.ingest_event (created_at DESC);

CREATE INDEX IF NOT EXISTS ingest_event_type_idx
  ON channels.ingest_event (event_type, created_at DESC);
