/**
 * Variant mapping access — design_no + job_no → external inventory/variant ids.
 * Schema `channels.variant_mapping` only.
 */
import { CHANNELS_SCHEMA, tryGetChannelsDb, type SqlClient } from "@/db/shared/client";

export type VariantMappingRow = {
  id: string;
  connection_id: string;
  design_no: string;
  job_no: string;
  external_variant_id: string;
  external_inventory_item_id: string | null;
};

export type VariantMappingStore = {
  getByDesignJob(
    connectionId: string,
    designNo: string,
    jobNo: string,
  ): Promise<VariantMappingRow | null>;
  deleteByDesign(connectionId: string, designNo: string): Promise<number>;
  upsert(input: {
    connectionId: string;
    designNo: string;
    jobNo: string;
    externalVariantId: string;
    externalInventoryItemId?: string | null;
  }): Promise<VariantMappingRow>;
};

function pgStore(db: SqlClient): VariantMappingStore {
  return {
    async getByDesignJob(connectionId, designNo, jobNo) {
      const result = await db.query<{
        id: string;
        connection_id: string;
        design_no: string;
        job_no: string;
        external_variant_id: string;
        external_inventory_item_id: string | null;
      }>(
        `SELECT id::text AS id,
                connection_id::text AS connection_id,
                design_no,
                job_no,
                external_variant_id,
                external_inventory_item_id
         FROM ${CHANNELS_SCHEMA}.variant_mapping
         WHERE connection_id = $1::uuid
           AND upper(replace(design_no, ' ', '')) = upper(replace($2, ' ', ''))
           AND upper(job_no) = upper($3)`,
        [connectionId, designNo, jobNo],
      );
      return result.rows[0] ?? null;
    },

    async deleteByDesign(connectionId, designNo) {
      const result = await db.query(
        `DELETE FROM ${CHANNELS_SCHEMA}.variant_mapping
         WHERE connection_id = $1::uuid
           AND upper(replace(design_no, ' ', '')) = upper(replace($2, ' ', ''))`,
        [connectionId, designNo],
      );
      return result.rowCount ?? 0;
    },

    async upsert(input) {
      const result = await db.query<{
        id: string;
        connection_id: string;
        design_no: string;
        job_no: string;
        external_variant_id: string;
        external_inventory_item_id: string | null;
      }>(
        `INSERT INTO ${CHANNELS_SCHEMA}.variant_mapping
           (connection_id, design_no, job_no, external_variant_id, external_inventory_item_id)
         VALUES ($1::uuid, $2, $3, $4, $5)
         ON CONFLICT (connection_id, design_no, job_no) DO UPDATE
           SET external_variant_id = EXCLUDED.external_variant_id,
               external_inventory_item_id = COALESCE(
                 EXCLUDED.external_inventory_item_id,
                 ${CHANNELS_SCHEMA}.variant_mapping.external_inventory_item_id
               ),
               updated_at = now()
         RETURNING id::text AS id,
                   connection_id::text AS connection_id,
                   design_no,
                   job_no,
                   external_variant_id,
                   external_inventory_item_id`,
        [
          input.connectionId,
          input.designNo,
          input.jobNo,
          input.externalVariantId,
          input.externalInventoryItemId ?? null,
        ],
      );
      return result.rows[0]!;
    },
  };
}

export function createMemoryVariantMappingStore(
  seed: VariantMappingRow[] = [],
): VariantMappingStore {
  const key = (c: string, d: string, j: string) =>
    `${c}|${d.replace(/\s+/g, "").toUpperCase()}|${j.toUpperCase()}`;
  const rows = new Map<string, VariantMappingRow>(
    seed.map((r) => [key(r.connection_id, r.design_no, r.job_no), { ...r }]),
  );
  return {
    async getByDesignJob(connectionId, designNo, jobNo) {
      return rows.get(key(connectionId, designNo, jobNo)) ?? null;
    },
    async deleteByDesign(connectionId, designNo) {
      const prefix = `${connectionId}|${designNo.replace(/\s+/g, "").toUpperCase()}|`;
      let deleted = 0;
      for (const mappingKey of rows.keys()) {
        if (mappingKey.startsWith(prefix) && rows.delete(mappingKey)) {
          deleted += 1;
        }
      }
      return deleted;
    },
    async upsert(input) {
      const k = key(input.connectionId, input.designNo, input.jobNo);
      const existing = rows.get(k);
      const row: VariantMappingRow = {
        id: existing?.id ?? crypto.randomUUID(),
        connection_id: input.connectionId,
        design_no: input.designNo,
        job_no: input.jobNo,
        external_variant_id: input.externalVariantId,
        external_inventory_item_id:
          input.externalInventoryItemId ??
          existing?.external_inventory_item_id ??
          null,
      };
      rows.set(k, row);
      return row;
    },
  };
}

let overrideStore: VariantMappingStore | null = null;

export function setVariantMappingStoreForTests(
  store: VariantMappingStore | null,
): void {
  overrideStore = store;
}

export function getVariantMappingStore(): VariantMappingStore {
  if (overrideStore) return overrideStore;
  const db = tryGetChannelsDb();
  if (!db) {
    throw new Error("DATABASE_URL required for variant mapping store (or set memory store)");
  }
  return pgStore(db);
}

export async function getVariantMapping(
  connectionId: string,
  designNo: string,
  jobNo: string,
): Promise<VariantMappingRow | null> {
  return getVariantMappingStore().getByDesignJob(connectionId, designNo, jobNo);
}
