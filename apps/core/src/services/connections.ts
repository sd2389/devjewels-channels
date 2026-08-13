/**
 * Channel connection access — schema `channels.connection` only.
 * Credentials are secret refs; never return resolved tokens from this layer.
 */
import { CHANNELS_SCHEMA, tryGetChannelsDb, type SqlClient } from "@/db/shared/client";
import type { ChannelPlatform } from "@/channels/types";
import type { MarkupMode } from "@/services/markup";

export type ConnectionRow = {
  id: string;
  platform: ChannelPlatform;
  name: string;
  is_active: boolean;
  credentials_secret_ref: string | null;
  customer_id: number | null;
  markup_mode: MarkupMode;
  markup_value: number;
  markup_bps: number;
  sync_inventory: boolean;
  sync_price: boolean;
  sync_products: boolean;
  sync_orders: boolean;
};

export type CreateConnectionInput = {
  platform: ChannelPlatform;
  name: string;
  credentialsSecretRef?: string | null;
  customerId: number;
  markupMode?: MarkupMode;
  markupValue?: number;
  markupBps?: number;
  syncInventory?: boolean;
  syncPrice?: boolean;
  syncProducts?: boolean;
  syncOrders?: boolean;
  isActive?: boolean;
};

export type ConnectionStore = {
  getById(id: string): Promise<ConnectionRow | null>;
  getByCustomerId(customerId: number): Promise<ConnectionRow | null>;
  list(limit?: number): Promise<ConnectionRow[]>;
  listActiveWithCustomer(limit?: number): Promise<ConnectionRow[]>;
  create(input: CreateConnectionInput): Promise<ConnectionRow>;
  setActive(id: string, isActive: boolean): Promise<ConnectionRow | null>;
  updateMarkup(
    id: string,
    markup: { markupMode: MarkupMode; markupValue: number },
  ): Promise<ConnectionRow | null>;
  updateCredentials(
    id: string,
    credentialsSecretRef: string,
    flags?: Partial<{
      syncInventory: boolean;
      syncProducts: boolean;
      syncOrders: boolean;
      isActive: boolean;
      name: string;
      customerId: number;
      markupMode: MarkupMode;
      markupValue: number;
    }>,
  ): Promise<ConnectionRow | null>;
};

type DbConnectionRow = {
  id: string;
  platform: string;
  name: string;
  is_active: boolean;
  credentials_secret_ref: string | null;
  customer_id: number | null;
  markup_mode: string;
  markup_value: string | number;
  markup_bps: number;
  sync_inventory: boolean;
  sync_price: boolean;
  sync_products: boolean;
  sync_orders: boolean;
};

function normalizeMarkupMode(raw: unknown): MarkupMode {
  const mode = String(raw || "none").trim().toLowerCase();
  if (mode === "percent" || mode === "multiplier") return mode;
  return "none";
}

function mapRow(row: DbConnectionRow): ConnectionRow | null {
  if (
    row.platform !== "SHOPIFY" &&
    row.platform !== "WOOCOMMERCE" &&
    row.platform !== "MAGENTO"
  ) {
    return null;
  }
  const customerId =
    row.customer_id == null || Number.isNaN(Number(row.customer_id))
      ? null
      : Number(row.customer_id);
  return {
    id: row.id,
    platform: row.platform,
    name: row.name,
    is_active: row.is_active,
    credentials_secret_ref: row.credentials_secret_ref,
    customer_id: customerId,
    markup_mode: normalizeMarkupMode(row.markup_mode),
    markup_value: Number(row.markup_value ?? 0) || 0,
    markup_bps: row.markup_bps,
    sync_inventory: row.sync_inventory,
    sync_price: row.sync_price,
    sync_products: row.sync_products ?? true,
    sync_orders: row.sync_orders,
  };
}

const SELECT_COLS = `id::text AS id, platform, name, is_active, credentials_secret_ref,
                customer_id, markup_mode, markup_value, markup_bps,
                sync_inventory, sync_price, sync_products, sync_orders`;

function pgStore(db: SqlClient): ConnectionStore {
  return {
    async getById(id) {
      const result = await db.query<DbConnectionRow>(
        `SELECT ${SELECT_COLS}
         FROM ${CHANNELS_SCHEMA}.connection
         WHERE id = $1::uuid`,
        [id],
      );
      const row = result.rows[0];
      return row ? mapRow(row) : null;
    },

    async getByCustomerId(customerId) {
      const result = await db.query<DbConnectionRow>(
        `SELECT ${SELECT_COLS}
         FROM ${CHANNELS_SCHEMA}.connection
         WHERE customer_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [customerId],
      );
      const row = result.rows[0];
      return row ? mapRow(row) : null;
    },

    async list(limit = 100) {
      const capped = Math.min(Math.max(limit, 1), 500);
      const result = await db.query<DbConnectionRow>(
        `SELECT ${SELECT_COLS}
         FROM ${CHANNELS_SCHEMA}.connection
         ORDER BY created_at DESC
         LIMIT $1`,
        [capped],
      );
      return result.rows
        .map(mapRow)
        .filter((row): row is ConnectionRow => row !== null);
    },

    async listActiveWithCustomer(limit = 50) {
      const capped = Math.min(Math.max(limit, 1), 200);
      const result = await db.query<DbConnectionRow>(
        `SELECT ${SELECT_COLS}
         FROM ${CHANNELS_SCHEMA}.connection
         WHERE is_active = TRUE
           AND customer_id IS NOT NULL
         ORDER BY created_at ASC
         LIMIT $1`,
        [capped],
      );
      return result.rows
        .map(mapRow)
        .filter((row): row is ConnectionRow => row !== null);
    },

    async create(input) {
      const customerId = Number(input.customerId);
      if (!Number.isInteger(customerId) || customerId <= 0) {
        throw new Error("customer_id is required to create a channel connection");
      }
      const existing = await this.getByCustomerId(customerId);
      if (existing) {
        throw new Error(
          `Customer ${customerId} already has a channel connection (${existing.id})`,
        );
      }
      const result = await db.query<DbConnectionRow>(
        `INSERT INTO ${CHANNELS_SCHEMA}.connection
           (platform, name, credentials_secret_ref, customer_id,
            markup_mode, markup_value, markup_bps,
            sync_inventory, sync_price, sync_products, sync_orders, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING ${SELECT_COLS}`,
        [
          input.platform,
          input.name,
          input.credentialsSecretRef ?? null,
          customerId,
          input.markupMode ?? "none",
          input.markupValue ?? 0,
          input.markupBps ?? 0,
          input.syncInventory ?? true,
          input.syncPrice ?? true,
          input.syncProducts ?? true,
          input.syncOrders ?? true,
          input.isActive ?? true,
        ],
      );
      const mapped = mapRow(result.rows[0]!);
      if (!mapped) throw new Error("createConnection returned invalid platform");
      return mapped;
    },

    async setActive(id, isActive) {
      const result = await db.query<DbConnectionRow>(
        `UPDATE ${CHANNELS_SCHEMA}.connection
         SET is_active = $2, updated_at = now()
         WHERE id = $1::uuid
         RETURNING ${SELECT_COLS}`,
        [id, isActive],
      );
      const row = result.rows[0];
      return row ? mapRow(row) : null;
    },

    async updateMarkup(id, markup) {
      const result = await db.query<DbConnectionRow>(
        `UPDATE ${CHANNELS_SCHEMA}.connection
         SET markup_mode = $2,
             markup_value = $3,
             updated_at = now()
         WHERE id = $1::uuid
         RETURNING ${SELECT_COLS}`,
        [id, markup.markupMode, markup.markupValue],
      );
      const row = result.rows[0];
      return row ? mapRow(row) : null;
    },

    async updateCredentials(id, credentialsSecretRef, flags) {
      const result = await db.query<DbConnectionRow>(
        `UPDATE ${CHANNELS_SCHEMA}.connection
         SET credentials_secret_ref = $2,
             sync_inventory = COALESCE($3, sync_inventory),
             sync_products = COALESCE($4, sync_products),
             sync_orders = COALESCE($5, sync_orders),
             is_active = COALESCE($6, is_active),
             name = COALESCE($7, name),
             customer_id = COALESCE($8, customer_id),
             markup_mode = COALESCE($9, markup_mode),
             markup_value = COALESCE($10, markup_value),
             updated_at = now()
         WHERE id = $1::uuid
         RETURNING ${SELECT_COLS}`,
        [
          id,
          credentialsSecretRef,
          flags?.syncInventory ?? null,
          flags?.syncProducts ?? null,
          flags?.syncOrders ?? null,
          flags?.isActive ?? null,
          flags?.name ?? null,
          flags?.customerId ?? null,
          flags?.markupMode ?? null,
          flags?.markupValue ?? null,
        ],
      );
      const row = result.rows[0];
      return row ? mapRow(row) : null;
    },
  };
}

/** In-memory CRUD for local selfcheck / tests (no Postgres). */
export function createMemoryConnectionStore(
  seed: ConnectionRow[] = [],
): ConnectionStore {
  const rows = new Map<string, ConnectionRow>(seed.map((r) => [r.id, { ...r }]));
  return {
    async getById(id) {
      return rows.get(id) ?? null;
    },
    async getByCustomerId(customerId) {
      return (
        [...rows.values()].find((r) => r.customer_id === customerId) ?? null
      );
    },
    async list(limit = 100) {
      return [...rows.values()].slice(0, limit);
    },
    async listActiveWithCustomer(limit = 50) {
      return [...rows.values()]
        .filter((r) => r.is_active && r.customer_id != null)
        .slice(0, limit);
    },
    async create(input) {
      const customerId = Number(input.customerId);
      if (!Number.isInteger(customerId) || customerId <= 0) {
        throw new Error("customer_id is required to create a channel connection");
      }
      for (const existing of rows.values()) {
        if (existing.customer_id === customerId) {
          throw new Error(
            `Customer ${customerId} already has a channel connection (${existing.id})`,
          );
        }
      }
      const id = crypto.randomUUID();
      const row: ConnectionRow = {
        id,
        platform: input.platform,
        name: input.name,
        is_active: input.isActive ?? true,
        credentials_secret_ref: input.credentialsSecretRef ?? null,
        customer_id: customerId,
        markup_mode: input.markupMode ?? "none",
        markup_value: input.markupValue ?? 0,
        markup_bps: input.markupBps ?? 0,
        sync_inventory: input.syncInventory ?? true,
        sync_price: input.syncPrice ?? true,
        sync_products: input.syncProducts ?? true,
        sync_orders: input.syncOrders ?? true,
      };
      rows.set(id, row);
      return row;
    },
    async setActive(id, isActive) {
      const existing = rows.get(id);
      if (!existing) return null;
      const next = { ...existing, is_active: isActive };
      rows.set(id, next);
      return next;
    },
    async updateMarkup(id, markup) {
      const existing = rows.get(id);
      if (!existing) return null;
      const next = {
        ...existing,
        markup_mode: markup.markupMode,
        markup_value: markup.markupValue,
      };
      rows.set(id, next);
      return next;
    },
    async updateCredentials(id, credentialsSecretRef, flags) {
      const existing = rows.get(id);
      if (!existing) return null;
      const next: ConnectionRow = {
        ...existing,
        credentials_secret_ref: credentialsSecretRef,
        sync_inventory: flags?.syncInventory ?? existing.sync_inventory,
        sync_products: flags?.syncProducts ?? existing.sync_products,
        sync_orders: flags?.syncOrders ?? existing.sync_orders,
        is_active: flags?.isActive ?? existing.is_active,
        name: flags?.name ?? existing.name,
        customer_id: flags?.customerId ?? existing.customer_id,
        markup_mode: flags?.markupMode ?? existing.markup_mode,
        markup_value: flags?.markupValue ?? existing.markup_value,
      };
      rows.set(id, next);
      return next;
    },
  };
}

let overrideStore: ConnectionStore | null = null;

export function setConnectionStoreForTests(store: ConnectionStore | null): void {
  overrideStore = store;
}

export function getConnectionStore(): ConnectionStore {
  if (overrideStore) return overrideStore;
  const db = tryGetChannelsDb();
  if (!db) {
    throw new Error("DATABASE_URL required for connection store (or set memory store in tests)");
  }
  return pgStore(db);
}

export async function getConnectionById(id: string): Promise<ConnectionRow | null> {
  return getConnectionStore().getById(id);
}

export async function getConnectionByCustomerId(
  customerId: number,
): Promise<ConnectionRow | null> {
  return getConnectionStore().getByCustomerId(customerId);
}

export async function createConnection(
  input: CreateConnectionInput,
): Promise<ConnectionRow> {
  return getConnectionStore().create(input);
}

export async function listConnections(limit?: number): Promise<ConnectionRow[]> {
  return getConnectionStore().list(limit);
}

export async function listActiveConnectionsWithCustomer(
  limit?: number,
): Promise<ConnectionRow[]> {
  return getConnectionStore().listActiveWithCustomer(limit);
}

export async function setConnectionActive(
  id: string,
  isActive: boolean,
): Promise<ConnectionRow | null> {
  return getConnectionStore().setActive(id, isActive);
}

export async function updateConnectionMarkup(
  id: string,
  markup: { markupMode: MarkupMode; markupValue: number },
): Promise<ConnectionRow | null> {
  return getConnectionStore().updateMarkup(id, markup);
}

export async function updateConnectionCredentials(
  id: string,
  credentialsSecretRef: string,
  flags?: Partial<{
    syncInventory: boolean;
    syncProducts: boolean;
    syncOrders: boolean;
    isActive: boolean;
    name: string;
    customerId: number;
    markupMode: MarkupMode;
    markupValue: number;
  }>,
): Promise<ConnectionRow | null> {
  return getConnectionStore().updateCredentials(id, credentialsSecretRef, flags);
}
