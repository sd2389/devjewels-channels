/**
 * Catalog import job rows — channels.catalog_import progress fields.
 */
import { CHANNELS_SCHEMA, tryGetChannelsDb, type SqlClient } from "@/db/shared/client";

export type CatalogImportStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export type CatalogImportRow = {
  id: string;
  connection_id: string;
  status: CatalogImportStatus;
  total_designs: number | null;
  processed: number;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at?: string;
};

export type CatalogImportStore = {
  create(connectionId: string): Promise<CatalogImportRow>;
  getById(id: string): Promise<CatalogImportRow | null>;
  markRunning(id: string, totalDesigns: number): Promise<CatalogImportRow | null>;
  bumpProcessed(id: string, by?: number): Promise<CatalogImportRow | null>;
  markCompleted(id: string): Promise<CatalogImportRow | null>;
  markFailed(id: string, errorMessage: string): Promise<CatalogImportRow | null>;
};

function mapRow(row: {
  id: string;
  connection_id: string;
  status: string;
  total_designs: number | null;
  processed: number;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at?: string;
}): CatalogImportRow {
  return {
    id: row.id,
    connection_id: row.connection_id,
    status: row.status as CatalogImportStatus,
    total_designs: row.total_designs,
    processed: row.processed,
    error_message: row.error_message,
    started_at: row.started_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
  };
}

function pgStore(db: SqlClient): CatalogImportStore {
  return {
    async create(connectionId) {
      const result = await db.query<{
        id: string;
        connection_id: string;
        status: string;
        total_designs: number | null;
        processed: number;
        error_message: string | null;
        started_at: string | null;
        completed_at: string | null;
        created_at: string;
      }>(
        `INSERT INTO ${CHANNELS_SCHEMA}.catalog_import (connection_id, status)
         VALUES ($1::uuid, 'pending')
         RETURNING id::text AS id,
                   connection_id::text AS connection_id,
                   status, total_designs, processed, error_message,
                   started_at::text AS started_at,
                   completed_at::text AS completed_at,
                   created_at::text AS created_at`,
        [connectionId],
      );
      return mapRow(result.rows[0]!);
    },

    async getById(id) {
      const result = await db.query<{
        id: string;
        connection_id: string;
        status: string;
        total_designs: number | null;
        processed: number;
        error_message: string | null;
        started_at: string | null;
        completed_at: string | null;
        created_at: string;
      }>(
        `SELECT id::text AS id,
                connection_id::text AS connection_id,
                status, total_designs, processed, error_message,
                started_at::text AS started_at,
                completed_at::text AS completed_at,
                created_at::text AS created_at
         FROM ${CHANNELS_SCHEMA}.catalog_import
         WHERE id = $1::uuid`,
        [id],
      );
      const row = result.rows[0];
      return row ? mapRow(row) : null;
    },

    async markRunning(id, totalDesigns) {
      const result = await db.query<{
        id: string;
        connection_id: string;
        status: string;
        total_designs: number | null;
        processed: number;
        error_message: string | null;
        started_at: string | null;
        completed_at: string | null;
        created_at: string;
      }>(
        `UPDATE ${CHANNELS_SCHEMA}.catalog_import
         SET status = 'running',
             total_designs = $2,
             started_at = COALESCE(started_at, now()),
             error_message = NULL
         WHERE id = $1::uuid
         RETURNING id::text AS id,
                   connection_id::text AS connection_id,
                   status, total_designs, processed, error_message,
                   started_at::text AS started_at,
                   completed_at::text AS completed_at,
                   created_at::text AS created_at`,
        [id, totalDesigns],
      );
      const row = result.rows[0];
      return row ? mapRow(row) : null;
    },

    async bumpProcessed(id, by = 1) {
      const result = await db.query<{
        id: string;
        connection_id: string;
        status: string;
        total_designs: number | null;
        processed: number;
        error_message: string | null;
        started_at: string | null;
        completed_at: string | null;
        created_at: string;
      }>(
        `UPDATE ${CHANNELS_SCHEMA}.catalog_import
         SET processed = processed + $2
         WHERE id = $1::uuid
         RETURNING id::text AS id,
                   connection_id::text AS connection_id,
                   status, total_designs, processed, error_message,
                   started_at::text AS started_at,
                   completed_at::text AS completed_at,
                   created_at::text AS created_at`,
        [id, by],
      );
      const row = result.rows[0];
      return row ? mapRow(row) : null;
    },

    async markCompleted(id) {
      const result = await db.query<{
        id: string;
        connection_id: string;
        status: string;
        total_designs: number | null;
        processed: number;
        error_message: string | null;
        started_at: string | null;
        completed_at: string | null;
        created_at: string;
      }>(
        `UPDATE ${CHANNELS_SCHEMA}.catalog_import
         SET status = 'completed', completed_at = now()
         WHERE id = $1::uuid
         RETURNING id::text AS id,
                   connection_id::text AS connection_id,
                   status, total_designs, processed, error_message,
                   started_at::text AS started_at,
                   completed_at::text AS completed_at,
                   created_at::text AS created_at`,
        [id],
      );
      const row = result.rows[0];
      return row ? mapRow(row) : null;
    },

    async markFailed(id, errorMessage) {
      const result = await db.query<{
        id: string;
        connection_id: string;
        status: string;
        total_designs: number | null;
        processed: number;
        error_message: string | null;
        started_at: string | null;
        completed_at: string | null;
        created_at: string;
      }>(
        `UPDATE ${CHANNELS_SCHEMA}.catalog_import
         SET status = 'failed',
             error_message = $2,
             completed_at = now()
         WHERE id = $1::uuid
         RETURNING id::text AS id,
                   connection_id::text AS connection_id,
                   status, total_designs, processed, error_message,
                   started_at::text AS started_at,
                   completed_at::text AS completed_at,
                   created_at::text AS created_at`,
        [id, errorMessage.slice(0, 2000)],
      );
      const row = result.rows[0];
      return row ? mapRow(row) : null;
    },
  };
}

export function createMemoryCatalogImportStore(): CatalogImportStore & {
  rows: CatalogImportRow[];
} {
  const rows: CatalogImportRow[] = [];
  return {
    rows,
    async create(connectionId) {
      const row: CatalogImportRow = {
        id: crypto.randomUUID(),
        connection_id: connectionId,
        status: "pending",
        total_designs: null,
        processed: 0,
        error_message: null,
        started_at: null,
        completed_at: null,
        created_at: new Date().toISOString(),
      };
      rows.push(row);
      return { ...row };
    },
    async getById(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async markRunning(id, totalDesigns) {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      row.status = "running";
      row.total_designs = totalDesigns;
      row.started_at = row.started_at ?? new Date().toISOString();
      row.error_message = null;
      return { ...row };
    },
    async bumpProcessed(id, by = 1) {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      row.processed += by;
      return { ...row };
    },
    async markCompleted(id) {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      row.status = "completed";
      row.completed_at = new Date().toISOString();
      return { ...row };
    },
    async markFailed(id, errorMessage) {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      row.status = "failed";
      row.error_message = errorMessage.slice(0, 2000);
      row.completed_at = new Date().toISOString();
      return { ...row };
    },
  };
}

let overrideStore: CatalogImportStore | null = null;

export function setCatalogImportStoreForTests(
  store: CatalogImportStore | null,
): void {
  overrideStore = store;
}

export function getCatalogImportStore(): CatalogImportStore {
  if (overrideStore) return overrideStore;
  const db = tryGetChannelsDb();
  if (!db) {
    throw new Error("DATABASE_URL required for catalog_import store (or set memory store)");
  }
  return pgStore(db);
}
