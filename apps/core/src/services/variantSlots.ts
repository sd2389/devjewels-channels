/**
 * Metal × Size variant slots — schema `channels.variant_slot` only.
 *
 * One row per Shopify variant of a `metal_size` connection. `job_nos` holds the
 * combination's live pieces cheapest first; `job_nos[0]` is the piece an order
 * reserves. `variant_mapping` is untouched and stays the piece-layout source.
 */
import { CHANNELS_SCHEMA, tryGetChannelsDb, type SqlClient } from "@/db/shared/client";

export type VariantSlotRow = {
  connection_id: string;
  design_no: string;
  slot_key: string;
  sku: string;
  external_variant_id: string;
  external_inventory_item_id: string | null;
  job_nos: string[];
};

export type VariantSlotInput = Omit<VariantSlotRow, "connection_id" | "design_no">;

export type VariantSlotStore = {
  getByExternalVariantId(connectionId: string, externalVariantId: string): Promise<VariantSlotRow | null>;
  getBySku(connectionId: string, sku: string): Promise<VariantSlotRow | null>;
  listByDesign(connectionId: string, designNo: string): Promise<VariantSlotRow[]>;
  /** Make the design's slots exactly `rows`: upsert these, delete the rest. */
  replaceForDesign(connectionId: string, designNo: string, rows: VariantSlotInput[]): Promise<void>;
  deleteByDesign(connectionId: string, designNo: string): Promise<number>;
};

const COLS = `connection_id::text AS connection_id, design_no, slot_key, sku,
              external_variant_id, external_inventory_item_id, job_nos`;

const DESIGN_MATCH = `upper(replace(design_no, ' ', '')) = upper(replace($2, ' ', ''))`;

function pgStore(db: SqlClient): VariantSlotStore {
  return {
    async getByExternalVariantId(connectionId, externalVariantId) {
      const gid = String(externalVariantId || "").trim();
      if (!gid) return null;
      const result = await db.query<VariantSlotRow>(
        `SELECT ${COLS} FROM ${CHANNELS_SCHEMA}.variant_slot
         WHERE connection_id = $1::uuid AND external_variant_id = $2
         LIMIT 1`,
        [connectionId, gid],
      );
      return result.rows[0] ?? null;
    },

    async getBySku(connectionId, sku) {
      const key = String(sku || "").trim();
      if (!key) return null;
      const result = await db.query<VariantSlotRow>(
        `SELECT ${COLS} FROM ${CHANNELS_SCHEMA}.variant_slot
         WHERE connection_id = $1::uuid AND sku = $2
         LIMIT 1`,
        [connectionId, key],
      );
      return result.rows[0] ?? null;
    },

    async listByDesign(connectionId, designNo) {
      const result = await db.query<VariantSlotRow>(
        `SELECT ${COLS} FROM ${CHANNELS_SCHEMA}.variant_slot
         WHERE connection_id = $1::uuid AND ${DESIGN_MATCH}
         ORDER BY slot_key ASC`,
        [connectionId, designNo],
      );
      return result.rows;
    },

    async replaceForDesign(connectionId, designNo, rows) {
      const keys = rows.map((r) => r.slot_key);
      // One statement each way, so a design's ~50 slots never cost 50 round trips.
      if (rows.length) {
        await db.query(
          `INSERT INTO ${CHANNELS_SCHEMA}.variant_slot
             (connection_id, design_no, slot_key, sku, external_variant_id,
              external_inventory_item_id, job_nos)
           SELECT $1::uuid, $2, x.slot_key, x.sku, x.external_variant_id,
                  x.external_inventory_item_id, COALESCE(x.job_nos, '{}')
           FROM jsonb_to_recordset($3::jsonb) AS x(
             slot_key text, sku text, external_variant_id text,
             external_inventory_item_id text, job_nos text[])
           ON CONFLICT (connection_id, design_no, slot_key) DO UPDATE
             SET sku = EXCLUDED.sku,
                 external_variant_id = EXCLUDED.external_variant_id,
                 external_inventory_item_id = COALESCE(
                   EXCLUDED.external_inventory_item_id,
                   ${CHANNELS_SCHEMA}.variant_slot.external_inventory_item_id
                 ),
                 job_nos = EXCLUDED.job_nos,
                 updated_at = now()`,
          [connectionId, designNo, JSON.stringify(rows)],
        );
      }
      await db.query(
        `DELETE FROM ${CHANNELS_SCHEMA}.variant_slot
         WHERE connection_id = $1::uuid AND ${DESIGN_MATCH}
           AND NOT (slot_key = ANY($3::text[]))`,
        [connectionId, designNo, keys],
      );
    },

    async deleteByDesign(connectionId, designNo) {
      const result = await db.query(
        `DELETE FROM ${CHANNELS_SCHEMA}.variant_slot
         WHERE connection_id = $1::uuid AND ${DESIGN_MATCH}`,
        [connectionId, designNo],
      );
      return result.rowCount ?? 0;
    },
  };
}

function designKey(designNo: string): string {
  return designNo.replace(/\s+/g, "").toUpperCase();
}

export function createMemoryVariantSlotStore(seed: VariantSlotRow[] = []): VariantSlotStore {
  const key = (c: string, d: string, s: string) => `${c}|${designKey(d)}|${s}`;
  const rows = new Map<string, VariantSlotRow>(
    seed.map((r) => [key(r.connection_id, r.design_no, r.slot_key), { ...r, job_nos: [...r.job_nos] }]),
  );
  const all = () => [...rows.values()];
  return {
    async getByExternalVariantId(connectionId, externalVariantId) {
      const gid = String(externalVariantId || "").trim();
      return all().find((r) => r.connection_id === connectionId && r.external_variant_id === gid) ?? null;
    },
    async getBySku(connectionId, sku) {
      const want = String(sku || "").trim();
      return all().find((r) => r.connection_id === connectionId && r.sku === want) ?? null;
    },
    async listByDesign(connectionId, designNo) {
      return all()
        .filter((r) => r.connection_id === connectionId && designKey(r.design_no) === designKey(designNo))
        .sort((a, b) => a.slot_key.localeCompare(b.slot_key));
    },
    async replaceForDesign(connectionId, designNo, input) {
      const keep = new Set(input.map((r) => r.slot_key));
      for (const [k, r] of rows) {
        if (r.connection_id === connectionId && designKey(r.design_no) === designKey(designNo) && !keep.has(r.slot_key)) {
          rows.delete(k);
        }
      }
      for (const r of input) {
        const k = key(connectionId, designNo, r.slot_key);
        const existing = rows.get(k);
        rows.set(k, {
          ...r,
          connection_id: connectionId,
          design_no: designNo,
          external_inventory_item_id:
            r.external_inventory_item_id ?? existing?.external_inventory_item_id ?? null,
          job_nos: [...r.job_nos],
        });
      }
    },
    async deleteByDesign(connectionId, designNo) {
      let n = 0;
      for (const [k, r] of rows) {
        if (r.connection_id === connectionId && designKey(r.design_no) === designKey(designNo)) {
          rows.delete(k);
          n += 1;
        }
      }
      return n;
    },
  };
}

let overrideStore: VariantSlotStore | null = null;

export function setVariantSlotStoreForTests(store: VariantSlotStore | null): void {
  overrideStore = store;
}

export function getVariantSlotStore(): VariantSlotStore {
  if (overrideStore) return overrideStore;
  const db = tryGetChannelsDb();
  if (!db) {
    throw new Error("DATABASE_URL required for variant slot store (or set memory store)");
  }
  return pgStore(db);
}
