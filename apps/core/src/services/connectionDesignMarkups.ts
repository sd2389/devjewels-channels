/**
 * Per-design markup overrides — schema `channels.connection_design_markup` only.
 * Design override wins over connection overall markup at price resolve time.
 */
import { CHANNELS_SCHEMA, tryGetChannelsDb, type SqlClient } from "@/db/shared/client";
import type { MarkupMode } from "@/services/markup";

export type ConnectionDesignMarkupRow = {
  id: string;
  connection_id: string;
  design_no: string;
  markup_mode: MarkupMode;
  markup_value: number;
};

export type DesignMarkupInput = {
  designNo: string;
  markupMode: MarkupMode;
  markupValue: number;
};

export type ConnectionDesignMarkupStore = {
  getByDesign(
    connectionId: string,
    designNo: string,
  ): Promise<ConnectionDesignMarkupRow | null>;
  listByConnection(
    connectionId: string,
    limit?: number,
  ): Promise<ConnectionDesignMarkupRow[]>;
  upsert(
    connectionId: string,
    input: DesignMarkupInput,
  ): Promise<ConnectionDesignMarkupRow>;
  /** Replace all overrides for a connection (empty list clears). */
  replaceAll(
    connectionId: string,
    rows: DesignMarkupInput[],
  ): Promise<ConnectionDesignMarkupRow[]>;
  deleteByDesign(connectionId: string, designNo: string): Promise<boolean>;
};

function normalizeMarkupMode(raw: unknown): MarkupMode {
  const mode = String(raw || "none").trim().toLowerCase();
  if (mode === "percent" || mode === "multiplier") return mode;
  return "none";
}

/** Stable key for uniqueness / lookup (trim + upper, collapse spaces). */
export function normalizeDesignNoKey(designNo: string): string {
  return designNo.replace(/\s+/g, "").trim().toUpperCase();
}

function mapRow(row: {
  id: string;
  connection_id: string;
  design_no: string;
  markup_mode: string;
  markup_value: string | number;
}): ConnectionDesignMarkupRow {
  return {
    id: row.id,
    connection_id: row.connection_id,
    design_no: row.design_no,
    markup_mode: normalizeMarkupMode(row.markup_mode),
    markup_value: Number(row.markup_value ?? 0) || 0,
  };
}

const SELECT_COLS = `id::text AS id,
                connection_id::text AS connection_id,
                design_no,
                markup_mode,
                markup_value`;

function pgStore(db: SqlClient): ConnectionDesignMarkupStore {
  return {
    async getByDesign(connectionId, designNo) {
      const result = await db.query<{
        id: string;
        connection_id: string;
        design_no: string;
        markup_mode: string;
        markup_value: string | number;
      }>(
        `SELECT ${SELECT_COLS}
         FROM ${CHANNELS_SCHEMA}.connection_design_markup
         WHERE connection_id = $1::uuid
           AND upper(replace(design_no, ' ', '')) = upper(replace($2, ' ', ''))`,
        [connectionId, designNo],
      );
      const row = result.rows[0];
      return row ? mapRow(row) : null;
    },

    async listByConnection(connectionId, limit = 500) {
      const capped = Math.min(Math.max(limit, 1), 2000);
      const result = await db.query<{
        id: string;
        connection_id: string;
        design_no: string;
        markup_mode: string;
        markup_value: string | number;
      }>(
        `SELECT ${SELECT_COLS}
         FROM ${CHANNELS_SCHEMA}.connection_design_markup
         WHERE connection_id = $1::uuid
         ORDER BY design_no ASC
         LIMIT $2`,
        [connectionId, capped],
      );
      return result.rows.map(mapRow);
    },

    async upsert(connectionId, input) {
      const designNo = normalizeDesignNoKey(input.designNo);
      if (!designNo) throw new Error("design_no is required");
      const result = await db.query<{
        id: string;
        connection_id: string;
        design_no: string;
        markup_mode: string;
        markup_value: string | number;
      }>(
        `INSERT INTO ${CHANNELS_SCHEMA}.connection_design_markup
           (connection_id, design_no, markup_mode, markup_value)
         VALUES ($1::uuid, $2, $3, $4)
         ON CONFLICT (connection_id, design_no) DO UPDATE
           SET markup_mode = EXCLUDED.markup_mode,
               markup_value = EXCLUDED.markup_value,
               updated_at = now()
         RETURNING ${SELECT_COLS}`,
        [connectionId, designNo, input.markupMode, input.markupValue],
      );
      return mapRow(result.rows[0]!);
    },

    async replaceAll(connectionId, rows) {
      await db.query(
        `DELETE FROM ${CHANNELS_SCHEMA}.connection_design_markup
         WHERE connection_id = $1::uuid`,
        [connectionId],
      );
      const out: ConnectionDesignMarkupRow[] = [];
      for (const row of rows) {
        out.push(await this.upsert(connectionId, row));
      }
      return out;
    },

    async deleteByDesign(connectionId, designNo) {
      const result = await db.query(
        `DELETE FROM ${CHANNELS_SCHEMA}.connection_design_markup
         WHERE connection_id = $1::uuid
           AND upper(replace(design_no, ' ', '')) = upper(replace($2, ' ', ''))`,
        [connectionId, designNo],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}

export function createMemoryConnectionDesignMarkupStore(
  seed: ConnectionDesignMarkupRow[] = [],
): ConnectionDesignMarkupStore {
  const key = (c: string, d: string) => `${c}|${normalizeDesignNoKey(d)}`;
  const rows = new Map<string, ConnectionDesignMarkupRow>(
    seed.map((r) => [key(r.connection_id, r.design_no), { ...r }]),
  );
  return {
    async getByDesign(connectionId, designNo) {
      return rows.get(key(connectionId, designNo)) ?? null;
    },
    async listByConnection(connectionId, limit = 500) {
      return [...rows.values()]
        .filter((r) => r.connection_id === connectionId)
        .slice(0, limit);
    },
    async upsert(connectionId, input) {
      const designNo = normalizeDesignNoKey(input.designNo);
      if (!designNo) throw new Error("design_no is required");
      const k = key(connectionId, designNo);
      const existing = rows.get(k);
      const row: ConnectionDesignMarkupRow = {
        id: existing?.id ?? crypto.randomUUID(),
        connection_id: connectionId,
        design_no: designNo,
        markup_mode: input.markupMode,
        markup_value: input.markupValue,
      };
      rows.set(k, row);
      return row;
    },
    async replaceAll(connectionId, next) {
      for (const [k, r] of [...rows.entries()]) {
        if (r.connection_id === connectionId) rows.delete(k);
      }
      const out: ConnectionDesignMarkupRow[] = [];
      for (const row of next) {
        out.push(await this.upsert(connectionId, row));
      }
      return out;
    },
    async deleteByDesign(connectionId, designNo) {
      return rows.delete(key(connectionId, designNo));
    },
  };
}

let overrideStore: ConnectionDesignMarkupStore | null = null;

export function setConnectionDesignMarkupStoreForTests(
  store: ConnectionDesignMarkupStore | null,
): void {
  overrideStore = store;
}

export function getConnectionDesignMarkupStore(): ConnectionDesignMarkupStore {
  if (overrideStore) return overrideStore;
  const db = tryGetChannelsDb();
  if (!db) {
    throw new Error(
      "DATABASE_URL required for connection design markup store (or set memory store)",
    );
  }
  return pgStore(db);
}

export async function listDesignMarkups(
  connectionId: string,
  limit?: number,
): Promise<ConnectionDesignMarkupRow[]> {
  return getConnectionDesignMarkupStore().listByConnection(connectionId, limit);
}

export async function getDesignMarkup(
  connectionId: string,
  designNo: string,
): Promise<ConnectionDesignMarkupRow | null> {
  return getConnectionDesignMarkupStore().getByDesign(connectionId, designNo);
}

export async function replaceDesignMarkups(
  connectionId: string,
  rows: DesignMarkupInput[],
): Promise<ConnectionDesignMarkupRow[]> {
  return getConnectionDesignMarkupStore().replaceAll(connectionId, rows);
}

/** Map design_no → override for O(1) lookup during import/sync. */
export async function loadDesignMarkupMap(
  connectionId: string,
): Promise<Map<string, { markupMode: MarkupMode; markupValue: number }>> {
  const rows = await listDesignMarkups(connectionId);
  const map = new Map<string, { markupMode: MarkupMode; markupValue: number }>();
  for (const row of rows) {
    map.set(normalizeDesignNoKey(row.design_no), {
      markupMode: row.markup_mode,
      markupValue: row.markup_value,
    });
  }
  return map;
}
