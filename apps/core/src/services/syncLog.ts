/**
 * Sync attempt log — channels.sync_log (SUCCESS | FAILED | RETRYING | SKIPPED).
 */
import { CHANNELS_SCHEMA, tryGetChannelsDb, type SqlClient } from "@/db/shared/client";
import type { ChannelPlatform } from "@/channels/types";

export type SyncLogStatus = "SUCCESS" | "FAILED" | "RETRYING" | "SKIPPED";

export type SyncLogInput = {
  connectionId: string | null;
  platform: ChannelPlatform | string;
  jobType: "inventory" | "price" | "product" | "order";
  status: SyncLogStatus;
  designNo?: string | null;
  jobNo?: string | null;
  message?: string | null;
  payloadRef?: string | null;
};

export type SyncLogRow = SyncLogInput & {
  id: string;
  created_at?: string;
};

export type SyncLogStore = {
  write(input: SyncLogInput): Promise<SyncLogRow>;
  listByConnection(connectionId: string, limit?: number): Promise<SyncLogRow[]>;
};

function pgStore(db: SqlClient): SyncLogStore {
  return {
    async write(input) {
      const result = await db.query<{ id: string }>(
        `INSERT INTO ${CHANNELS_SCHEMA}.sync_log
           (connection_id, platform, job_type, status, design_no, job_no, message, payload_ref)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id::text AS id`,
        [
          input.connectionId,
          input.platform,
          input.jobType,
          input.status,
          input.designNo ?? null,
          input.jobNo ?? null,
          input.message ?? null,
          input.payloadRef ?? null,
        ],
      );
      return { id: result.rows[0]!.id, ...input };
    },

    async listByConnection(connectionId, limit = 50) {
      const capped = Math.min(Math.max(limit, 1), 200);
      const result = await db.query<{
        id: string;
        connection_id: string | null;
        platform: string;
        job_type: string;
        status: string;
        design_no: string | null;
        job_no: string | null;
        message: string | null;
        payload_ref: string | null;
        created_at: string;
      }>(
        `SELECT id::text AS id,
                connection_id::text AS connection_id,
                platform, job_type, status, design_no, job_no, message, payload_ref,
                created_at::text AS created_at
         FROM ${CHANNELS_SCHEMA}.sync_log
         WHERE connection_id = $1::uuid
         ORDER BY created_at DESC
         LIMIT $2`,
        [connectionId, capped],
      );
      return result.rows.map((row) => ({
        id: row.id,
        connectionId: row.connection_id,
        platform: row.platform,
        jobType: row.job_type as SyncLogInput["jobType"],
        status: row.status as SyncLogStatus,
        designNo: row.design_no,
        jobNo: row.job_no,
        message: row.message,
        payloadRef: row.payload_ref,
        created_at: row.created_at,
      }));
    },
  };
}

export function createMemorySyncLogStore(): SyncLogStore & { rows: SyncLogRow[] } {
  const rows: SyncLogRow[] = [];
  return {
    rows,
    async write(input) {
      const row: SyncLogRow = {
        id: crypto.randomUUID(),
        ...input,
        created_at: new Date().toISOString(),
      };
      rows.push(row);
      return row;
    },
    async listByConnection(connectionId, limit = 50) {
      return rows
        .filter((r) => r.connectionId === connectionId)
        .slice(-limit)
        .reverse();
    },
  };
}

let overrideStore: SyncLogStore | null = null;

export function setSyncLogStoreForTests(store: SyncLogStore | null): void {
  overrideStore = store;
}

export function getSyncLogStore(): SyncLogStore {
  if (overrideStore) return overrideStore;
  const db = tryGetChannelsDb();
  if (!db) {
    // Local Next without DB: log-only no-op store so workers do not crash.
    return {
      async write(input) {
        console.info("sync_log_memory", {
          connectionId: input.connectionId,
          platform: input.platform,
          jobType: input.jobType,
          status: input.status,
          designNo: input.designNo,
          jobNo: input.jobNo,
          message: input.message,
        });
        return { id: "memory", ...input };
      },
      async listByConnection() {
        return [];
      },
    };
  }
  return pgStore(db);
}

export async function writeSyncLog(input: SyncLogInput): Promise<SyncLogRow> {
  return getSyncLogStore().write(input);
}
