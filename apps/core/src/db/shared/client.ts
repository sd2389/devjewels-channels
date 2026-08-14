/**
 * Shared Channels DB access — same Postgres as Dev Jewels (`devjewels`), schema `channels` only.
 * Hard rule: never SELECT/JOIN public SoT tables.
 */
import { Pool, type QueryResultRow } from "pg";
import { optionalServerEnv } from "../../config/serverEnv";

export const CHANNELS_SCHEMA = optionalServerEnv("CHANNELS_SCHEMA") ?? "channels";

export type SqlClient = {
  query: <T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: T[]; rowCount: number }>;
};

let pool: Pool | null = null;

/** Guard: refuse queries that touch public schema. */
export function assertChannelsOnlySql(sql: string): void {
  const normalized = sql.toLowerCase();
  if (
    /\bpublic\./.test(normalized) ||
    /\bfrom\s+public\b/.test(normalized) ||
    /\bjoin\s+public\b/.test(normalized)
  ) {
    throw new Error("Forbidden: Channels must not query public schema tables");
  }
}

function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    // Force session search_path so unqualified names stay in channels when used carefully.
    options: `-c search_path=${CHANNELS_SCHEMA}`,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

function resolveDatabaseUrl(): string | undefined {
  // Explicit empty disables DB (selfchecks). Do not fall through to .env.
  if (process.env.DATABASE_URL === "") return undefined;
  return optionalServerEnv("DATABASE_URL");
}

/**
 * Pooled client for schema `channels` on the shared Dev Jewels database.
 * Returns null when DATABASE_URL is unset (local Next-only without DB).
 */
export function tryGetChannelsDb(): SqlClient | null {
  const connectionString = resolveDatabaseUrl();
  if (!connectionString) {
    return null;
  }
  if (!pool) {
    pool = createPool(connectionString);
  }
  const active = pool;
  return {
    async query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
      assertChannelsOnlySql(text);
      const result = await active.query<T>(text, params);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
  };
}

/** Placeholder-compatible accessor — throws when DB is not configured. */
export function getChannelsDb(): SqlClient {
  const client = tryGetChannelsDb();
  if (!client) {
    throw new Error(
      "Channels DB client not configured. Set DATABASE_URL to the shared Dev Jewels Postgres (schema channels).",
    );
  }
  return client;
}

/** Test helper: reset pool between tests. */
export async function closeChannelsDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
