/**
 * Connect Shopify binding security selfcheck (memory stores + mocked Shopify HTTP).
 * Task 2: customer_id required, 1:1 shop↔customer, key/entitlements gate, markup.
 * Run: npm run selfcheck:connect -w @devjewels-channels/core
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  createMemoryConnectionStore,
  getConnectionById,
  listConnections,
  setConnectionStoreForTests,
} from "./connections";
import { connectShopifyStore } from "./connectShopifyService";
import {
  createMemoryShopifyMetaStore,
  setShopifyMetaStoreForTests,
} from "@devjewels-channels/shopify";
import {
  DeverpHttpError,
  setDeverpClientForTests,
  type DeverpClient,
  type DeverpEntitlements,
} from "../integrations/deverp/client";
import {
  createMemoryCatalogImportStore,
  setCatalogImportStoreForTests,
} from "./catalogImportStore";
import {
  createMemoryProductMappingStore,
  setProductMappingStoreForTests,
} from "./productMappings";
import {
  createMemoryVariantMappingStore,
  setVariantMappingStoreForTests,
} from "./variantMappings";
import {
  createMemorySyncLogStore,
  setSyncLogStoreForTests,
} from "./syncLog";
import { clearEntitlementCache } from "./entitlements";

const LOCATIONS_BODY = {
  data: {
    locations: {
      edges: [
        { node: { id: "gid://shopify/Location/1", name: "Main", isActive: true } },
        { node: { id: "gid://shopify/Location/2", name: "Backup", isActive: true } },
      ],
    },
  },
};

function baseEntitlements(
  customerId: number,
  overrides: Partial<DeverpEntitlements> = {},
): DeverpEntitlements {
  return {
    customer_id: customerId,
    key_present: true,
    api_key_id: 1,
    permissions: {
      can_view_designs: true,
      can_view_inventory: true,
      can_view_prices: true,
      can_place_orders: false,
    },
    design_nos: [],
    design_count: 0,
    design_nos_truncated: false,
    ...overrides,
  };
}

function entitlementsClient(
  customerId: number,
  overrides: Partial<DeverpEntitlements> = {},
): DeverpClient {
  const ent = baseEntitlements(customerId, overrides);
  return {
    async listCatalogDesigns() {
      return {
        items: [],
        limit: 50,
        after_id: null,
        next_after_id: null,
        has_more: false,
        count: 0,
        customer_id: customerId,
      };
    },
    async getProduct() {
      throw new Error("unused");
    },
    async getInventory() {
      return {
        design_no: "x",
        job_no: null,
        available_count: 0,
        truncated: false,
        jobs: [],
      };
    },
    async getPrice() {
      throw new Error("unused");
    },
    async getEntitlements() {
      return ent;
    },
    async checkEntitlements() {
      return { design_no: "x", entitled: [], count: 0 };
    },
    async reserveOrder() {
      throw new Error("unused");
    },
  };
}

function assertRejects(
  label: string,
  fn: () => Promise<unknown>,
  messageIncludes?: string,
): Promise<void> {
  return fn().then(
    () => {
      throw new Error(`expected reject: ${label}`);
    },
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (messageIncludes && !msg.includes(messageIncludes)) {
        throw new Error(
          `reject ${label}: expected message to include ${JSON.stringify(messageIncludes)}, got ${JSON.stringify(msg)}`,
        );
      }
    },
  );
}

async function resetStores(): Promise<void> {
  clearEntitlementCache();
  const connections = createMemoryConnectionStore();
  setConnectionStoreForTests(connections);
  const meta = createMemoryShopifyMetaStore();
  setShopifyMetaStoreForTests(meta);
  setCatalogImportStoreForTests(createMemoryCatalogImportStore());
  setProductMappingStoreForTests(createMemoryProductMappingStore());
  setVariantMappingStoreForTests(createMemoryVariantMappingStore());
  setSyncLogStoreForTests(createMemorySyncLogStore());
}

async function main(): Promise<void> {
  const vaultDir = path.join(process.cwd(), ".data", "secrets-connect-selfcheck");
  await fs.rm(vaultDir, { recursive: true, force: true });
  process.env.CHANNELS_VAULT_DIR = vaultDir;
  process.env.CHANNELS_PUBLIC_BASE_URL = "https://channels.example.com";
  process.env.SHOPIFY_API_SECRET = "whsec_connect";
  process.env.SHOPIFY_API_VERSION = "2025-01";

  await resetStores();
  setDeverpClientForTests(entitlementsClient(99));

  const originalFetch = globalThis.fetch;
  let webhookPosts = 0;
  globalThis.fetch = (async (url, init) => {
    const u = String(url);
    const method = (init?.method || "GET").toUpperCase();
    if (u.includes("/graphql.json")) {
      return new Response(JSON.stringify(LOCATIONS_BODY), { status: 200 });
    }
    if (u.includes("/webhooks.json") && method === "GET") {
      return new Response(JSON.stringify({ webhooks: [] }), { status: 200 });
    }
    if (u.includes("/webhooks.json") && method === "POST") {
      webhookPosts += 1;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      const topic = body?.webhook?.topic || "unknown";
      return new Response(
        JSON.stringify({ webhook: { id: webhookPosts, topic } }),
        { status: 201 },
      );
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  try {
    // --- Denied: missing / invalid customer_id ---
    await assertRejects(
      "missing customer_id",
      () =>
        connectShopifyStore({
          shopDomain: "ghost.myshopify.com",
          accessToken: "shpat_x",
          customerId: 0,
        }),
      "customer_id is required",
    );
    await assertRejects(
      "NaN customer_id",
      () =>
        connectShopifyStore({
          shopDomain: "ghost.myshopify.com",
          accessToken: "shpat_x",
          customerId: Number.NaN,
        }),
      "customer_id is required",
    );
    if ((await listConnections()).length !== 0) {
      throw new Error("denied customer_id must not write a connection");
    }

    // --- Denied: key_present=false ---
    clearEntitlementCache();
    setDeverpClientForTests(
      entitlementsClient(50, { key_present: false, api_key_id: null }),
    );
    await assertRejects(
      "key_present=false",
      () =>
        connectShopifyStore({
          shopDomain: "nokey.myshopify.com",
          accessToken: "shpat_x",
          customerId: 50,
        }),
      "active API key",
    );
    if ((await listConnections()).length !== 0) {
      throw new Error("key_present=false must not write a connection");
    }

    // --- Denied: can_view_designs=false ---
    clearEntitlementCache();
    setDeverpClientForTests(
      entitlementsClient(51, {
        permissions: {
          can_view_designs: false,
          can_view_inventory: true,
          can_view_prices: true,
          can_place_orders: true,
        },
      }),
    );
    await assertRejects(
      "can_view_designs=false",
      () =>
        connectShopifyStore({
          shopDomain: "nodesign.myshopify.com",
          accessToken: "shpat_x",
          customerId: 51,
        }),
      "can_view_designs",
    );

    // --- Denied: entitlements client error → fail closed (no half-write) ---
    clearEntitlementCache();
    setDeverpClientForTests({
      ...entitlementsClient(52),
      async getEntitlements() {
        throw new DeverpHttpError(503, "entitlements unavailable");
      },
    });
    await assertRejects(
      "entitlements 503",
      () =>
        connectShopifyStore({
          shopDomain: "fail.myshopify.com",
          accessToken: "shpat_x",
          customerId: 52,
        }),
    );
    if ((await listConnections()).length !== 0) {
      throw new Error("entitlements error must not leave a half-written connection");
    }

    // --- Happy path: bind + syncOrders from can_place_orders + markup ---
    clearEntitlementCache();
    setDeverpClientForTests(
      entitlementsClient(99, {
        permissions: {
          can_view_designs: true,
          can_view_inventory: true,
          can_view_prices: true,
          can_place_orders: true,
        },
      }),
    );
    const first = await connectShopifyStore({
      shopDomain: "acme.myshopify.com",
      accessToken: "shpat_one",
      customerId: 99,
      markupMode: "percent",
      markupValue: 12.5,
    });
    if (first.reconnected) throw new Error("first connect should not be reconnect");
    if (first.connection.customer_id !== 99) {
      throw new Error("connection must bind customer_id");
    }
    if (first.connection.sync_orders !== true) {
      throw new Error("syncOrders must derive from can_place_orders=true");
    }
    if (first.connection.markup_mode !== "percent" || first.connection.markup_value !== 12.5) {
      throw new Error("markup_mode / markup_value must persist on connect");
    }
    if (first.locations.length !== 2) throw new Error("expected 2 locations");
    if (first.webhooks.length !== 3) throw new Error("expected 3 webhooks");

    // --- Reconnect same shop + same customer is idempotent ---
    const second = await connectShopifyStore({
      shopDomain: "acme.myshopify.com",
      accessToken: "shpat_two",
      customerId: 99,
      markupMode: "multiplier",
      markupValue: 1.25,
    });
    if (!second.reconnected) throw new Error("second connect should reconnect");
    if (second.connection.id !== first.connection.id) {
      throw new Error("reconnect must reuse connection id");
    }
    if (second.connection.customer_id !== 99) {
      throw new Error("reconnect must keep customer_id");
    }
    if (second.connection.sync_orders !== true) {
      throw new Error("reconnect syncOrders must stay derived from can_place_orders");
    }
    if (
      second.connection.markup_mode !== "multiplier" ||
      second.connection.markup_value !== 1.25
    ) {
      throw new Error("reconnect must persist updated markup");
    }

    // --- Reconnect must re-derive syncOrders when can_place_orders flips ---
    clearEntitlementCache();
    setDeverpClientForTests(
      entitlementsClient(99, {
        permissions: {
          can_view_designs: true,
          can_view_inventory: true,
          can_view_prices: true,
          can_place_orders: false,
        },
      }),
    );
    const afterPermFlip = await connectShopifyStore({
      shopDomain: "acme.myshopify.com",
      accessToken: "shpat_three",
      customerId: 99,
    });
    if (!afterPermFlip.reconnected) {
      throw new Error("perm-flip reconnect expected");
    }
    if (afterPermFlip.connection.sync_orders !== false) {
      throw new Error(
        "reconnect must set syncOrders=false when can_place_orders=false",
      );
    }

    // Restore can_place_orders for later conflict cases that reuse customer 99
    clearEntitlementCache();
    setDeverpClientForTests(
      entitlementsClient(99, {
        permissions: {
          can_view_designs: true,
          can_view_inventory: true,
          can_view_prices: true,
          can_place_orders: true,
        },
      }),
    );

    // --- Denied: customer already has a different shop ---
    await assertRejects(
      "customer already connected to other shop",
      () =>
        connectShopifyStore({
          shopDomain: "other.myshopify.com",
          accessToken: "shpat_x",
          customerId: 99,
        }),
      "already has",
    );

    // --- Denied: shop already bound to a different customer ---
    clearEntitlementCache();
    setDeverpClientForTests(
      entitlementsClient(200, {
        permissions: {
          can_view_designs: true,
          can_view_inventory: true,
          can_view_prices: true,
          can_place_orders: false,
        },
      }),
    );
    await assertRejects(
      "shop bound to other customer",
      () =>
        connectShopifyStore({
          shopDomain: "acme.myshopify.com",
          accessToken: "shpat_other",
          customerId: 200,
        }),
      "already connected to another customer",
    );
    const stillOwner = await getConnectionById(first.connection.id);
    if (!stillOwner || stillOwner.customer_id !== 99) {
      throw new Error("shop conflict must not rebind customer_id");
    }

    // --- Fail-closed: UNIQUE(shop_domain) at meta store (concurrent race equivalent) ---
    const metaStore = (
      await import("@devjewels-channels/shopify")
    ).getShopifyMetaStore();
    await assertRejects(
      "shop_domain unique at meta store",
      () => metaStore.upsertShop(crypto.randomUUID(), "acme.myshopify.com"),
      "already connected to another customer",
    );

    // --- syncOrders=false when can_place_orders=false ---
    clearEntitlementCache();
    setDeverpClientForTests(
      entitlementsClient(300, {
        permissions: {
          can_view_designs: true,
          can_view_inventory: true,
          can_view_prices: true,
          can_place_orders: false,
        },
      }),
    );
    const noOrders = await connectShopifyStore({
      shopDomain: "orders-off.myshopify.com",
      accessToken: "shpat_no_orders",
      customerId: 300,
      skipWebhookRegistration: true,
    });
    if (noOrders.connection.sync_orders !== false) {
      throw new Error("syncOrders must be false when can_place_orders=false");
    }

    console.log("connect.selfcheck OK");
  } finally {
    globalThis.fetch = originalFetch;
    setConnectionStoreForTests(null);
    setShopifyMetaStoreForTests(null);
    setDeverpClientForTests(null);
    clearEntitlementCache();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
