/**
 * Shopify-owned metadata in schema channels (shopify_connection, shopify_location).
 */
import {
  CHANNELS_SCHEMA,
  tryGetChannelsDb,
  type SqlClient,
} from "../../core/src/db/shared/client";

export type ShopifyLocationRow = {
  connection_id: string;
  external_location_id: string;
  name: string | null;
  is_primary: boolean;
};

export type ShopifyShopRow = {
  connection_id: string;
  shop_domain: string;
};

export type ShopifyOAuthStateRow = {
  shop_domain: string;
  state: string;
};

export type ShopifyWebhookSubscriptionRow = {
  connection_id: string;
  topic: string;
  external_webhook_id: string | null;
};

export type ShopifyMetaStore = {
  getPrimaryLocation(connectionId: string): Promise<ShopifyLocationRow | null>;
  listLocations(connectionId: string): Promise<ShopifyLocationRow[]>;
  getShop(connectionId: string): Promise<ShopifyShopRow | null>;
  getConnectionIdByShopDomain(shopDomain: string): Promise<string | null>;
  upsertShop(connectionId: string, shopDomain: string): Promise<ShopifyShopRow>;
  upsertLocation(input: {
    connectionId: string;
    externalLocationId: string;
    name?: string | null;
    isPrimary?: boolean;
  }): Promise<ShopifyLocationRow>;
  createOAuthState(input: {
    shopDomain: string;
    state: string;
    expiresAt: Date;
  }): Promise<void>;
  /** One-time consume; returns null when missing/expired. */
  consumeOAuthState(state: string): Promise<ShopifyOAuthStateRow | null>;
  upsertWebhookSubscription(input: {
    connectionId: string;
    topic: string;
    externalWebhookId?: string | null;
  }): Promise<ShopifyWebhookSubscriptionRow>;
  listWebhookSubscriptions(
    connectionId: string,
  ): Promise<ShopifyWebhookSubscriptionRow[]>;
};

function pgStore(db: SqlClient): ShopifyMetaStore {
  return {
    async getPrimaryLocation(connectionId) {
      const result = await db.query<{
        connection_id: string;
        external_location_id: string;
        name: string | null;
        is_primary: boolean;
      }>(
        `SELECT connection_id::text AS connection_id,
                external_location_id,
                name,
                is_primary
         FROM ${CHANNELS_SCHEMA}.shopify_location
         WHERE connection_id = $1::uuid
         ORDER BY is_primary DESC, created_at ASC
         LIMIT 1`,
        [connectionId],
      );
      return result.rows[0] ?? null;
    },

    async listLocations(connectionId) {
      const result = await db.query<{
        connection_id: string;
        external_location_id: string;
        name: string | null;
        is_primary: boolean;
      }>(
        `SELECT connection_id::text AS connection_id,
                external_location_id,
                name,
                is_primary
         FROM ${CHANNELS_SCHEMA}.shopify_location
         WHERE connection_id = $1::uuid
         ORDER BY is_primary DESC, name ASC NULLS LAST`,
        [connectionId],
      );
      return result.rows;
    },

    async getShop(connectionId) {
      const result = await db.query<{
        connection_id: string;
        shop_domain: string;
      }>(
        `SELECT connection_id::text AS connection_id, shop_domain
         FROM ${CHANNELS_SCHEMA}.shopify_connection
         WHERE connection_id = $1::uuid`,
        [connectionId],
      );
      return result.rows[0] ?? null;
    },

    async getConnectionIdByShopDomain(shopDomain) {
      const normalized = shopDomain.trim().toLowerCase();
      if (!normalized) return null;
      const result = await db.query<{ connection_id: string }>(
        `SELECT connection_id::text AS connection_id
         FROM ${CHANNELS_SCHEMA}.shopify_connection
         WHERE lower(shop_domain) = $1
         LIMIT 1`,
        [normalized],
      );
      return result.rows[0]?.connection_id ?? null;
    },

    async upsertShop(connectionId, shopDomain) {
      try {
        const result = await db.query<{
          connection_id: string;
          shop_domain: string;
        }>(
          `INSERT INTO ${CHANNELS_SCHEMA}.shopify_connection (connection_id, shop_domain)
           VALUES ($1::uuid, $2)
           ON CONFLICT (connection_id) DO UPDATE
             SET shop_domain = EXCLUDED.shop_domain, updated_at = now()
           RETURNING connection_id::text AS connection_id, shop_domain`,
          [connectionId, shopDomain],
        );
        return result.rows[0]!;
      } catch (err) {
        // 23505 = unique_violation (shop_domain lower() unique index).
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code: unknown }).code)
            : "";
        if (code === "23505") {
          throw new Error(
            "This Shopify shop is already connected to another customer",
          );
        }
        throw err;
      }
    },

    async upsertLocation(input) {
      if (input.isPrimary) {
        await db.query(
          `UPDATE ${CHANNELS_SCHEMA}.shopify_location
           SET is_primary = FALSE
           WHERE connection_id = $1::uuid`,
          [input.connectionId],
        );
      }
      const result = await db.query<{
        connection_id: string;
        external_location_id: string;
        name: string | null;
        is_primary: boolean;
      }>(
        `INSERT INTO ${CHANNELS_SCHEMA}.shopify_location
           (connection_id, external_location_id, name, is_primary)
         VALUES ($1::uuid, $2, $3, $4)
         ON CONFLICT (connection_id, external_location_id) DO UPDATE
           SET name = COALESCE(EXCLUDED.name, ${CHANNELS_SCHEMA}.shopify_location.name),
               is_primary = EXCLUDED.is_primary
         RETURNING connection_id::text AS connection_id,
                   external_location_id,
                   name,
                   is_primary`,
        [
          input.connectionId,
          input.externalLocationId,
          input.name ?? null,
          input.isPrimary ?? false,
        ],
      );
      return result.rows[0]!;
    },

    async createOAuthState(input) {
      await db.query(
        `INSERT INTO ${CHANNELS_SCHEMA}.shopify_oauth_state
           (shop_domain, state, expires_at)
         VALUES ($1, $2, $3)`,
        [input.shopDomain, input.state, input.expiresAt.toISOString()],
      );
    },

    async consumeOAuthState(state) {
      const trimmed = state.trim();
      if (!trimmed) return null;
      const result = await db.query<{
        shop_domain: string;
        state: string;
      }>(
        `DELETE FROM ${CHANNELS_SCHEMA}.shopify_oauth_state
         WHERE state = $1
           AND expires_at > now()
         RETURNING shop_domain, state`,
        [trimmed],
      );
      const row = result.rows[0];
      return row ? { shop_domain: row.shop_domain, state: row.state } : null;
    },

    async upsertWebhookSubscription(input) {
      const result = await db.query<{
        connection_id: string;
        topic: string;
        external_webhook_id: string | null;
      }>(
        `INSERT INTO ${CHANNELS_SCHEMA}.shopify_webhook_subscription
           (connection_id, topic, external_webhook_id)
         VALUES ($1::uuid, $2, $3)
         ON CONFLICT (connection_id, topic) DO UPDATE
           SET external_webhook_id = COALESCE(
             EXCLUDED.external_webhook_id,
             ${CHANNELS_SCHEMA}.shopify_webhook_subscription.external_webhook_id
           )
         RETURNING connection_id::text AS connection_id, topic, external_webhook_id`,
        [
          input.connectionId,
          input.topic,
          input.externalWebhookId ?? null,
        ],
      );
      return result.rows[0]!;
    },

    async listWebhookSubscriptions(connectionId) {
      const result = await db.query<{
        connection_id: string;
        topic: string;
        external_webhook_id: string | null;
      }>(
        `SELECT connection_id::text AS connection_id, topic, external_webhook_id
         FROM ${CHANNELS_SCHEMA}.shopify_webhook_subscription
         WHERE connection_id = $1::uuid
         ORDER BY topic ASC`,
        [connectionId],
      );
      return result.rows;
    },
  };
}

export function createMemoryShopifyMetaStore(seed?: {
  shops?: ShopifyShopRow[];
  locations?: ShopifyLocationRow[];
}): ShopifyMetaStore {
  const shops = new Map<string, ShopifyShopRow>(
    (seed?.shops ?? []).map((s) => [s.connection_id, { ...s }]),
  );
  const locations = new Map<string, ShopifyLocationRow[]>();
  for (const loc of seed?.locations ?? []) {
    const list = locations.get(loc.connection_id) ?? [];
    list.push({ ...loc });
    locations.set(loc.connection_id, list);
  }
  const oauthStates = new Map<
    string,
    { shop_domain: string; expires_at: number }
  >();
  const webhooks = new Map<string, ShopifyWebhookSubscriptionRow[]>();

  return {
    async getPrimaryLocation(connectionId) {
      const list = locations.get(connectionId) ?? [];
      return list.find((l) => l.is_primary) ?? list[0] ?? null;
    },
    async listLocations(connectionId) {
      return [...(locations.get(connectionId) ?? [])];
    },
    async getShop(connectionId) {
      return shops.get(connectionId) ?? null;
    },
    async getConnectionIdByShopDomain(shopDomain) {
      const normalized = shopDomain.trim().toLowerCase();
      for (const row of shops.values()) {
        if (row.shop_domain.trim().toLowerCase() === normalized) {
          return row.connection_id;
        }
      }
      return null;
    },
    async upsertShop(connectionId, shopDomain) {
      const normalized = shopDomain.trim().toLowerCase();
      for (const [id, existing] of shops) {
        if (
          id !== connectionId &&
          existing.shop_domain.trim().toLowerCase() === normalized
        ) {
          throw new Error(
            "This Shopify shop is already connected to another customer",
          );
        }
      }
      const row = { connection_id: connectionId, shop_domain: shopDomain };
      shops.set(connectionId, row);
      return row;
    },
    async upsertLocation(input) {
      const list = locations.get(input.connectionId) ?? [];
      if (input.isPrimary) {
        for (const l of list) l.is_primary = false;
      }
      const existing = list.find(
        (l) => l.external_location_id === input.externalLocationId,
      );
      const row: ShopifyLocationRow = {
        connection_id: input.connectionId,
        external_location_id: input.externalLocationId,
        name: input.name ?? existing?.name ?? null,
        is_primary: input.isPrimary ?? existing?.is_primary ?? false,
      };
      if (existing) Object.assign(existing, row);
      else {
        list.push(row);
        locations.set(input.connectionId, list);
      }
      return row;
    },
    async createOAuthState(input) {
      oauthStates.set(input.state, {
        shop_domain: input.shopDomain,
        expires_at: input.expiresAt.getTime(),
      });
    },
    async consumeOAuthState(state) {
      const trimmed = state.trim();
      const row = oauthStates.get(trimmed);
      if (!row) return null;
      oauthStates.delete(trimmed);
      if (row.expires_at <= Date.now()) return null;
      return { shop_domain: row.shop_domain, state: trimmed };
    },
    async upsertWebhookSubscription(input) {
      const list = webhooks.get(input.connectionId) ?? [];
      const existing = list.find((w) => w.topic === input.topic);
      const row: ShopifyWebhookSubscriptionRow = {
        connection_id: input.connectionId,
        topic: input.topic,
        external_webhook_id:
          input.externalWebhookId ?? existing?.external_webhook_id ?? null,
      };
      if (existing) Object.assign(existing, row);
      else {
        list.push(row);
        webhooks.set(input.connectionId, list);
      }
      return row;
    },
    async listWebhookSubscriptions(connectionId) {
      return [...(webhooks.get(connectionId) ?? [])];
    },
  };
}

let overrideStore: ShopifyMetaStore | null = null;

export function setShopifyMetaStoreForTests(store: ShopifyMetaStore | null): void {
  overrideStore = store;
}

export function getShopifyMetaStore(): ShopifyMetaStore {
  if (overrideStore) return overrideStore;
  const db = tryGetChannelsDb();
  if (!db) {
    throw new Error(
      "DATABASE_URL required for shopify meta store (or set memory store in tests)",
    );
  }
  return pgStore(db);
}
