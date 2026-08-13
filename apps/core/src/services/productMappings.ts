/**
 * Product mapping access — design_no → external product id.
 * Schema `channels.product_mapping` only.
 */
import { CHANNELS_SCHEMA, tryGetChannelsDb, type SqlClient } from "@/db/shared/client";

export type ProductMappingRow = {
  id: string;
  connection_id: string;
  design_no: string;
  external_product_id: string;
};

export type ProductMappingStore = {
  getByDesign(
    connectionId: string,
    designNo: string,
  ): Promise<ProductMappingRow | null>;
  listByConnection(connectionId: string, limit?: number): Promise<ProductMappingRow[]>;
  upsert(input: {
    connectionId: string;
    designNo: string;
    externalProductId: string;
  }): Promise<ProductMappingRow>;
  deleteByDesign(connectionId: string, designNo: string): Promise<boolean>;
};

function pgStore(db: SqlClient): ProductMappingStore {
  return {
    async getByDesign(connectionId, designNo) {
      const result = await db.query<{
        id: string;
        connection_id: string;
        design_no: string;
        external_product_id: string;
      }>(
        `SELECT id::text AS id,
                connection_id::text AS connection_id,
                design_no,
                external_product_id
         FROM ${CHANNELS_SCHEMA}.product_mapping
         WHERE connection_id = $1::uuid
           AND upper(replace(design_no, ' ', '')) = upper(replace($2, ' ', ''))`,
        [connectionId, designNo],
      );
      return result.rows[0] ?? null;
    },

    async listByConnection(connectionId, limit = 5000) {
      const capped = Math.min(Math.max(limit, 1), 10000);
      const result = await db.query<{
        id: string;
        connection_id: string;
        design_no: string;
        external_product_id: string;
      }>(
        `SELECT id::text AS id,
                connection_id::text AS connection_id,
                design_no,
                external_product_id
         FROM ${CHANNELS_SCHEMA}.product_mapping
         WHERE connection_id = $1::uuid
         ORDER BY design_no ASC
         LIMIT $2`,
        [connectionId, capped],
      );
      return result.rows;
    },

    async upsert(input) {
      const result = await db.query<{
        id: string;
        connection_id: string;
        design_no: string;
        external_product_id: string;
      }>(
        `INSERT INTO ${CHANNELS_SCHEMA}.product_mapping
           (connection_id, design_no, external_product_id)
         VALUES ($1::uuid, $2, $3)
         ON CONFLICT (connection_id, design_no) DO UPDATE
           SET external_product_id = EXCLUDED.external_product_id,
               updated_at = now()
         RETURNING id::text AS id,
                   connection_id::text AS connection_id,
                   design_no,
                   external_product_id`,
        [input.connectionId, input.designNo, input.externalProductId],
      );
      return result.rows[0]!;
    },

    async deleteByDesign(connectionId, designNo) {
      const result = await db.query(
        `DELETE FROM ${CHANNELS_SCHEMA}.product_mapping
         WHERE connection_id = $1::uuid
           AND upper(replace(design_no, ' ', '')) = upper(replace($2, ' ', ''))`,
        [connectionId, designNo],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}

export function createMemoryProductMappingStore(
  seed: ProductMappingRow[] = [],
): ProductMappingStore {
  const key = (c: string, d: string) =>
    `${c}|${d.replace(/\s+/g, "").toUpperCase()}`;
  const rows = new Map<string, ProductMappingRow>(
    seed.map((r) => [key(r.connection_id, r.design_no), { ...r }]),
  );
  return {
    async getByDesign(connectionId, designNo) {
      return rows.get(key(connectionId, designNo)) ?? null;
    },
    async listByConnection(connectionId, limit = 5000) {
      return [...rows.values()]
        .filter((r) => r.connection_id === connectionId)
        .slice(0, limit);
    },
    async upsert(input) {
      const k = key(input.connectionId, input.designNo);
      const existing = rows.get(k);
      const row: ProductMappingRow = {
        id: existing?.id ?? crypto.randomUUID(),
        connection_id: input.connectionId,
        design_no: input.designNo,
        external_product_id: input.externalProductId,
      };
      rows.set(k, row);
      return row;
    },
    async deleteByDesign(connectionId, designNo) {
      return rows.delete(key(connectionId, designNo));
    },
  };
}

let overrideStore: ProductMappingStore | null = null;

export function setProductMappingStoreForTests(
  store: ProductMappingStore | null,
): void {
  overrideStore = store;
}

export function getProductMappingStore(): ProductMappingStore {
  if (overrideStore) return overrideStore;
  const db = tryGetChannelsDb();
  if (!db) {
    throw new Error("DATABASE_URL required for product mapping store (or set memory store)");
  }
  return pgStore(db);
}

export async function upsertProductMapping(input: {
  connectionId: string;
  designNo: string;
  externalProductId: string;
}): Promise<ProductMappingRow> {
  return getProductMappingStore().upsert(input);
}
