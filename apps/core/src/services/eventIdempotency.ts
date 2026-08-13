/**
 * Idempotency for Django → Channels ingest by event_id.
 * Prefers channels.ingest_event on the shared Dev Jewels Postgres; falls back to memory.
 */
import { CHANNELS_SCHEMA, tryGetChannelsDb } from "@/db/shared/client";

const memorySeen = new Map<string, number>();
const MEMORY_TTL_MS = 24 * 60 * 60 * 1000;

function pruneMemory(now: number): void {
  for (const [id, ts] of memorySeen) {
    if (now - ts > MEMORY_TTL_MS) memorySeen.delete(id);
  }
}

export type ClaimResult = { duplicate: boolean; store: "db" | "memory" };

/**
 * Atomically claim event_id. Returns duplicate=true if already seen.
 * DB path uses INSERT … ON CONFLICT on channels.ingest_event.
 */
export async function claimEventId(
  eventId: string,
  eventType: string,
  occurredAt: string,
  payload: unknown,
): Promise<ClaimResult> {
  const db = tryGetChannelsDb();
  if (db) {
    try {
      const result = await db.query<{ event_id: string }>(
        `INSERT INTO ${CHANNELS_SCHEMA}.ingest_event (event_id, event_type, occurred_at, payload)
         VALUES ($1, $2, $3::timestamptz, $4::jsonb)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [eventId, eventType, occurredAt, JSON.stringify(payload)],
      );
      if (result.rowCount === 0) {
        return { duplicate: true, store: "db" };
      }
      return { duplicate: false, store: "db" };
    } catch (err) {
      // Schema not applied yet — fall back to memory (shared DB still required for prod).
      console.warn("ingest_event_db_unavailable", {
        error_type: err instanceof Error ? err.name : "Error",
      });
    }
  }

  const now = Date.now();
  pruneMemory(now);
  if (memorySeen.has(eventId)) {
    return { duplicate: true, store: "memory" };
  }
  memorySeen.set(eventId, now);
  return { duplicate: false, store: "memory" };
}

/** Test helper. */
export function resetMemoryIdempotencyStore(): void {
  memorySeen.clear();
}
