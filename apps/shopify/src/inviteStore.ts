/**
 * DB-backed single-use invite jti tracking (schema channels.shopify_connect_invite).
 */
import {
  CHANNELS_SCHEMA,
  tryGetChannelsDb,
  type SqlClient,
} from "../../core/src/db/shared/client";

export type ShopifyConnectInviteRow = {
  jti: string;
  customer_id: number;
  shop_domain: string;
  expires_at: Date;
  consumed_at: Date | null;
};

export type ShopifyInviteStore = {
  createInvite(input: {
    jti: string;
    customerId: number;
    shopDomain: string;
    expiresAt: Date;
  }): Promise<void>;
  /** Atomically mark consumed; returns null when missing/expired/already used. */
  consumeInvite(jti: string): Promise<ShopifyConnectInviteRow | null>;
  /** Latest unconsumed, unexpired invite for a shop. Does not consume. */
  findPendingByShopDomain(
    shopDomain: string,
  ): Promise<ShopifyConnectInviteRow | null>;
};

function pgStore(db: SqlClient): ShopifyInviteStore {
  return {
    async createInvite(input) {
      await db.query(
        `INSERT INTO ${CHANNELS_SCHEMA}.shopify_connect_invite
           (jti, customer_id, shop_domain, expires_at)
         VALUES ($1::uuid, $2, $3, $4)`,
        [input.jti, input.customerId, input.shopDomain, input.expiresAt.toISOString()],
      );
    },

    async consumeInvite(jti) {
      const trimmed = jti.trim();
      if (!trimmed) return null;
      const result = await db.query<{
        jti: string;
        customer_id: number;
        shop_domain: string;
        expires_at: Date;
        consumed_at: Date | null;
      }>(
        `UPDATE ${CHANNELS_SCHEMA}.shopify_connect_invite
         SET consumed_at = now()
         WHERE jti = $1::uuid
           AND consumed_at IS NULL
           AND expires_at > now()
         RETURNING jti::text AS jti,
                   customer_id,
                   shop_domain,
                   expires_at,
                   consumed_at`,
        [trimmed],
      );
      return result.rows[0] ?? null;
    },

    async findPendingByShopDomain(shopDomain) {
      const normalized = shopDomain.trim().toLowerCase();
      if (!normalized) return null;
      const result = await db.query<{
        jti: string;
        customer_id: number;
        shop_domain: string;
        expires_at: Date;
        consumed_at: Date | null;
      }>(
        `SELECT jti::text AS jti,
                customer_id,
                shop_domain,
                expires_at,
                consumed_at
         FROM ${CHANNELS_SCHEMA}.shopify_connect_invite
         WHERE lower(shop_domain) = $1
           AND consumed_at IS NULL
           AND expires_at > now()
         ORDER BY created_at DESC
         LIMIT 1`,
        [normalized],
      );
      return result.rows[0] ?? null;
    },
  };
}

export function createMemoryShopifyInviteStore(): ShopifyInviteStore & {
  rows: Map<string, ShopifyConnectInviteRow>;
} {
  const rows = new Map<string, ShopifyConnectInviteRow>();
  return {
    rows,
    async createInvite(input) {
      rows.set(input.jti, {
        jti: input.jti,
        customer_id: input.customerId,
        shop_domain: input.shopDomain,
        expires_at: input.expiresAt,
        consumed_at: null,
      });
    },
    async consumeInvite(jti) {
      const row = rows.get(jti.trim());
      if (!row || row.consumed_at) return null;
      if (row.expires_at.getTime() <= Date.now()) return null;
      row.consumed_at = new Date();
      return { ...row };
    },
    async findPendingByShopDomain(shopDomain) {
      const normalized = shopDomain.trim().toLowerCase();
      if (!normalized) return null;
      let best: ShopifyConnectInviteRow | null = null;
      for (const row of rows.values()) {
        if (row.consumed_at) continue;
        if (row.expires_at.getTime() <= Date.now()) continue;
        if (row.shop_domain.trim().toLowerCase() !== normalized) continue;
        if (!best || row.expires_at.getTime() > best.expires_at.getTime()) {
          best = row;
        }
      }
      return best ? { ...best } : null;
    },
  };
}

let overrideStore: ShopifyInviteStore | null = null;

export function setShopifyInviteStoreForTests(store: ShopifyInviteStore | null): void {
  overrideStore = store;
}

export function getShopifyInviteStore(): ShopifyInviteStore {
  if (overrideStore) return overrideStore;
  const db = tryGetChannelsDb();
  if (!db) {
    throw new Error(
      "DATABASE_URL required for shopify invite store (or set memory store in tests)",
    );
  }
  return pgStore(db);
}
