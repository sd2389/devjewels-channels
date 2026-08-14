-- Per-design markup overrides on a connection.
-- Effective price: funnel final_price → design override if present else connection overall markup.
-- Safe to re-run (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS channels.connection_design_markup (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id   UUID NOT NULL REFERENCES channels.connection (id) ON DELETE CASCADE,
  design_no       TEXT NOT NULL,
  markup_mode     TEXT NOT NULL DEFAULT 'none'
                  CHECK (markup_mode IN ('none', 'percent', 'multiplier')),
  markup_value    NUMERIC(12, 4) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, design_no)
);

CREATE INDEX IF NOT EXISTS connection_design_markup_connection_idx
  ON channels.connection_design_markup (connection_id);

CREATE INDEX IF NOT EXISTS connection_design_markup_design_idx
  ON channels.connection_design_markup (design_no);
