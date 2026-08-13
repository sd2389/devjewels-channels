/**
 * Webhook event persistence — channels.webhook_event with external_event_id dedupe.
 */
import { CHANNELS_SCHEMA, tryGetChannelsDb, type SqlClient } from "@/db/shared/client";

export type WebhookEventRow = {
  id: string;
  connection_id: string | null;
  platform: string;
  external_event_id: string;
  topic: string;
  status: string;
  payload_ref: string | null;
};

export type WebhookEventStore = {
  /**
   * Insert event. Returns duplicate=true when (platform, external_event_id) exists.
   */
  claim(input: {
    connectionId: string | null;
    platform: string;
    externalEventId: string;
    topic: string;
    payloadRef?: string | null;
  }): Promise<{ duplicate: boolean; row: WebhookEventRow }>;
  getById(id: string): Promise<WebhookEventRow | null>;
  markStatus(id: string, status: string): Promise<void>;
};

function mapRow(row: {
  id: string;
  connection_id: string | null;
  platform: string;
  external_event_id: string;
  topic: string;
  status: string;
  payload_ref: string | null;
}): WebhookEventRow {
  return {
    id: row.id,
    connection_id: row.connection_id,
    platform: row.platform,
    external_event_id: row.external_event_id,
    topic: row.topic,
    status: row.status,
    payload_ref: row.payload_ref,
  };
}

function pgStore(db: SqlClient): WebhookEventStore {
  return {
    async claim(input) {
      const inserted = await db.query<{
        id: string;
        connection_id: string | null;
        platform: string;
        external_event_id: string;
        topic: string;
        status: string;
        payload_ref: string | null;
      }>(
        `INSERT INTO ${CHANNELS_SCHEMA}.webhook_event
           (connection_id, platform, external_event_id, topic, status, payload_ref)
         VALUES ($1::uuid, $2, $3, $4, 'received', $5)
         ON CONFLICT (platform, external_event_id) DO NOTHING
         RETURNING id::text AS id,
                   connection_id::text AS connection_id,
                   platform, external_event_id, topic, status, payload_ref`,
        [
          input.connectionId,
          input.platform,
          input.externalEventId,
          input.topic,
          input.payloadRef ?? null,
        ],
      );
      if (inserted.rows[0]) {
        return { duplicate: false, row: mapRow(inserted.rows[0]) };
      }
      const existing = await db.query<{
        id: string;
        connection_id: string | null;
        platform: string;
        external_event_id: string;
        topic: string;
        status: string;
        payload_ref: string | null;
      }>(
        `SELECT id::text AS id,
                connection_id::text AS connection_id,
                platform, external_event_id, topic, status, payload_ref
         FROM ${CHANNELS_SCHEMA}.webhook_event
         WHERE platform = $1 AND external_event_id = $2`,
        [input.platform, input.externalEventId],
      );
      return { duplicate: true, row: mapRow(existing.rows[0]!) };
    },

    async getById(id) {
      const result = await db.query<{
        id: string;
        connection_id: string | null;
        platform: string;
        external_event_id: string;
        topic: string;
        status: string;
        payload_ref: string | null;
      }>(
        `SELECT id::text AS id,
                connection_id::text AS connection_id,
                platform, external_event_id, topic, status, payload_ref
         FROM ${CHANNELS_SCHEMA}.webhook_event
         WHERE id = $1::uuid`,
        [id],
      );
      const row = result.rows[0];
      return row ? mapRow(row) : null;
    },

    async markStatus(id, status) {
      await db.query(
        `UPDATE ${CHANNELS_SCHEMA}.webhook_event SET status = $2 WHERE id = $1::uuid`,
        [id, status],
      );
    },
  };
}

export function createMemoryWebhookEventStore(): WebhookEventStore & {
  rows: WebhookEventRow[];
} {
  const rows: WebhookEventRow[] = [];
  const key = (p: string, e: string) => `${p}|${e}`;
  const byKey = new Map<string, WebhookEventRow>();
  return {
    rows,
    async claim(input) {
      const k = key(input.platform, input.externalEventId);
      const existing = byKey.get(k);
      if (existing) {
        return { duplicate: true, row: { ...existing } };
      }
      const row: WebhookEventRow = {
        id: crypto.randomUUID(),
        connection_id: input.connectionId,
        platform: input.platform,
        external_event_id: input.externalEventId,
        topic: input.topic,
        status: "received",
        payload_ref: input.payloadRef ?? null,
      };
      rows.push(row);
      byKey.set(k, row);
      return { duplicate: false, row: { ...row } };
    },
    async getById(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async markStatus(id, status) {
      const row = rows.find((r) => r.id === id);
      if (row) row.status = status;
    },
  };
}

let overrideStore: WebhookEventStore | null = null;

export function setWebhookEventStoreForTests(
  store: WebhookEventStore | null,
): void {
  overrideStore = store;
}

export function getWebhookEventStore(): WebhookEventStore {
  if (overrideStore) return overrideStore;
  const db = tryGetChannelsDb();
  if (!db) {
    // Local Next without DB: memory fallback so webhook path is testable.
    return createMemoryWebhookEventStore();
  }
  return pgStore(db);
}
