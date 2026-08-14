/**
 * Orders path selfcheck — HMAC, can_place_orders gate, markup math, reserve deny/success.
 * Run: npm run selfcheck:orders -w @devjewels-channels/core
 *
 * Markup formulas (asserted via markupSelfcheck):
 * - none: passthrough
 * - percent: price * (1 + value/100)
 * - multiplier: price * value  (e.g. ×3)
 */
import { createHmac } from "node:crypto";
import { registerDefaultAdapters } from "../channels/registerAdapters";
import { resetAdaptersForTests } from "../channels/router";
import {
  createMemoryConnectionStore,
  setConnectionStoreForTests,
} from "./connections";
import {
  createMemorySyncLogStore,
  setSyncLogStoreForTests,
} from "./syncLog";
import {
  createMemoryWebhookEventStore,
  setWebhookEventStoreForTests,
} from "./webhookEvents";
import {
  DeverpHttpError,
  setDeverpClientForTests,
  type DeverpClient,
  type DeverpEntitlements,
  type DeverpReserveOrderPayload,
  type DeverpReserveOrderResult,
} from "../integrations/deverp/client";
import { clearEntitlementCache } from "./entitlements";
import { runOrderProcessingJob } from "./orderProcessingService";
import { drainMemoryOrderQueue, enqueueOrderProcessing } from "./queue";
import { applyConnectionMarkup, markupSelfcheck } from "./markup";
import {
  createMemoryShopifyMetaStore,
  setShopifyMetaStoreForTests,
} from "../../../shopify/src/meta";
import { shopifyAdapter } from "../../../shopify/src/adapter";
import { verifyShopifyWebhookHmac } from "../../../shopify/src/webhooks";
import { normalizeShopifyOrder } from "../../../shopify/src/orders";
import { resetAdaptersReadyForTests } from "../workers/handlers";

const CONN = "55555555-5555-5555-5555-555555555555";
const WEBHOOK_SECRET = "whsec_orders_selfcheck";
const SHPAT = "shpat_ORDERS_SECRET_LEAK_TEST";

function hmac(raw: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("base64");
}

function baseEntitlements(
  overrides: Partial<DeverpEntitlements> & {
    permissions?: Partial<DeverpEntitlements["permissions"]>;
  } = {},
): DeverpEntitlements {
  return {
    customer_id: 55,
    key_present: overrides.key_present ?? true,
    api_key_id: overrides.api_key_id ?? 1,
    permissions: {
      can_view_designs: true,
      can_view_inventory: true,
      can_view_prices: true,
      can_place_orders: true,
      ...overrides.permissions,
    },
    design_nos: overrides.design_nos ?? ["DJ-ORD"],
    design_count: overrides.design_count ?? 1,
    design_nos_truncated: overrides.design_nos_truncated ?? false,
  };
}

function unusedClient(
  overrides: Partial<DeverpClient> & {
    reserveOrder?: (payload: DeverpReserveOrderPayload) => Promise<DeverpReserveOrderResult>;
  },
): DeverpClient {
  return {
    async listCatalogDesigns() {
      throw new Error("unused");
    },
    async getProduct() {
      throw new Error("unused");
    },
    async getInventory() {
      throw new Error("unused");
    },
    async getPrice() {
      throw new Error("unused");
    },
    async getEntitlements() {
      return baseEntitlements();
    },
    async checkEntitlements() {
      return { design_no: "x", entitled: [], count: 0 };
    },
    async reserveOrder() {
      throw new Error("reserveOrder must not be called");
    },
    ...overrides,
  };
}

function assertNoSecrets(blob: string): void {
  const lower = blob.toLowerCase();
  if (lower.includes(SHPAT.toLowerCase())) {
    throw new Error("denied path leaked Shopify access token");
  }
  if (lower.includes(WEBHOOK_SECRET.toLowerCase())) {
    throw new Error("denied path leaked webhook secret");
  }
  if (lower.includes("traceback") || lower.includes("select *")) {
    throw new Error("denied path leaked internals");
  }
}

async function main(): Promise<void> {
  process.env.CHANNELS_SHOPIFY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.CHANNELS_SECRET_orders_selfcheck = JSON.stringify({
    accessToken: SHPAT,
    shopDomain: "orders.myshopify.com",
    webhookSecret: WEBHOOK_SECRET,
  });

  // --- Markup math (percent + multiplier + none + edge values) ---
  markupSelfcheck();
  // Explicit Task 5 formulas called out in plan
  if (applyConnectionMarkup(100, { markupMode: "percent", markupValue: 10 }) !== 110) {
    throw new Error("percent formula: price * (1 + value/100) failed");
  }
  if (applyConnectionMarkup(100, { markupMode: "multiplier", markupValue: 3 }) !== 300) {
    throw new Error("multiplier formula: price * value (×3) failed");
  }
  if (applyConnectionMarkup(50, { markupMode: "none" }) !== 50) {
    throw new Error("none markup must passthrough API price");
  }

  const syncLogs = createMemorySyncLogStore();
  const webhooks = createMemoryWebhookEventStore();
  setSyncLogStoreForTests(syncLogs);
  setWebhookEventStoreForTests(webhooks);
  const connections = createMemoryConnectionStore([
      {
        id: CONN,
        platform: "SHOPIFY",
        name: "orders",
        is_active: true,
        credentials_secret_ref: "env:CHANNELS_SECRET_orders_selfcheck",
        customer_id: 55,
        markup_mode: "none",
        markup_value: 0,
        markup_bps: 0,
        sync_inventory: true,
        sync_price: true,
        sync_products: true,
        sync_orders: true,
      },
    ]);
  setConnectionStoreForTests(connections);
  setShopifyMetaStoreForTests(
    createMemoryShopifyMetaStore({
      shops: [{ connection_id: CONN, shop_domain: "orders.myshopify.com" }],
    }),
  );

  resetAdaptersForTests();
  resetAdaptersReadyForTests();
  registerDefaultAdapters();

  const orderPayload = {
    id: 9001,
    admin_graphql_api_id: "gid://shopify/Order/9001",
    currency: "USD",
    email: "buyer@example.com",
    line_items: [
      {
        id: 1,
        sku: "JOB-9",
        quantity: 1,
        properties: [{ name: "design_no", value: "DJ-ORD" }],
      },
    ],
  };
  const rawBody = JSON.stringify(orderPayload);

  // 1) bad HMAC → verify throws
  let badHmac = false;
  try {
    await shopifyAdapter.verifyWebhook({
      connectionId: CONN,
      headers: { "x-shopify-hmac-sha256": "invalid" },
      rawBody,
    });
  } catch {
    badHmac = true;
  }
  if (!badHmac) throw new Error("expected bad HMAC to throw");
  if (
    verifyShopifyWebhookHmac({
      rawBody,
      hmacHeader: "invalid",
      secret: WEBHOOK_SECRET,
    })
  ) {
    throw new Error("verifyShopifyWebhookHmac should reject bad signature");
  }

  // 2) good HMAC
  await shopifyAdapter.verifyWebhook({
    connectionId: CONN,
    headers: { "x-shopify-hmac-sha256": hmac(rawBody) },
    rawBody,
  });

  // 3) normalize
  const normalized = normalizeShopifyOrder(orderPayload, CONN);
  if (normalized.lines[0]?.designNo !== "DJ-ORD") {
    throw new Error("normalize design_no mismatch");
  }
  if (normalized.lines[0]?.jobNo !== "JOB-9") {
    throw new Error("normalize job_no mismatch");
  }

  // 4) webhook dedupe
  const first = await webhooks.claim({
    connectionId: CONN,
    platform: "SHOPIFY",
    externalEventId: "evt-1",
    topic: "orders/create",
    payloadRef: rawBody,
  });
  if (first.duplicate) throw new Error("first claim should not be duplicate");
  const second = await webhooks.claim({
    connectionId: CONN,
    platform: "SHOPIFY",
    externalEventId: "evt-1",
    topic: "orders/create",
    payloadRef: rawBody,
  });
  if (!second.duplicate) throw new Error("second claim should be duplicate");

  await enqueueOrderProcessing({
    kind: "order.process",
    connectionId: CONN,
    platform: "SHOPIFY",
    webhookEventId: first.row.id,
  });
  const queued = drainMemoryOrderQueue();
  if (queued.length !== 1) throw new Error("expected 1 order job enqueued");

  // 5) can_place_orders=false → SKIPPED, reserve never called
  clearEntitlementCache();
  let reserveCalls = 0;
  setDeverpClientForTests(
    unusedClient({
      async getEntitlements() {
        return baseEntitlements({ permissions: { can_place_orders: false } });
      },
      async reserveOrder() {
        reserveCalls += 1;
        throw new Error("reserve must not run when can_place_orders=false");
      },
    }),
  );
  const gateDenied = await runOrderProcessingJob(queued[0]!);
  if (gateDenied !== "SKIPPED") {
    throw new Error(`expected SKIPPED for can_place_orders=false, got ${gateDenied}`);
  }
  if (reserveCalls !== 0) {
    throw new Error("reserveOrder must not be called when can_place_orders=false");
  }
  const gateLog = syncLogs.rows.at(-1);
  if (gateLog?.status !== "SKIPPED" || gateLog.message !== "can_place_orders_false") {
    throw new Error(`expected can_place_orders_false sync_log, got ${JSON.stringify(gateLog)}`);
  }
  assertNoSecrets(JSON.stringify(gateLog));

  // 6) no active API key → SKIPPED, reserve never called
  clearEntitlementCache();
  const claimNoKey = await webhooks.claim({
    connectionId: CONN,
    platform: "SHOPIFY",
    externalEventId: "evt-nokey",
    topic: "orders/create",
    payloadRef: rawBody,
  });
  reserveCalls = 0;
  setDeverpClientForTests(
    unusedClient({
      async getEntitlements() {
        return baseEntitlements({
          key_present: false,
          api_key_id: null,
          permissions: { can_place_orders: false },
        });
      },
      async reserveOrder() {
        reserveCalls += 1;
        throw new Error("reserve must not run without API key");
      },
    }),
  );
  const noKey = await runOrderProcessingJob({
    kind: "order.process",
    connectionId: CONN,
    platform: "SHOPIFY",
    webhookEventId: claimNoKey.row.id,
  });
  if (noKey !== "SKIPPED") throw new Error(`expected SKIPPED for no key, got ${noKey}`);
  if (reserveCalls !== 0) throw new Error("reserveOrder must not run without API key");
  const noKeyLog = syncLogs.rows.at(-1);
  if (noKeyLog?.message !== "no_active_api_key") {
    throw new Error(`expected no_active_api_key, got ${noKeyLog?.message}`);
  }
  assertNoSecrets(JSON.stringify(noKeyLog));

  // 7) full revoke disables order sync before any entitlement or reserve call
  await connections.updateSyncFlags(CONN, {
    syncInventory: false,
    syncPrice: false,
    syncProducts: false,
    syncOrders: false,
  });
  const claimRevoked = await webhooks.claim({
    connectionId: CONN,
    platform: "SHOPIFY",
    externalEventId: "evt-key-revoked",
    topic: "orders/create",
    payloadRef: rawBody,
  });
  reserveCalls = 0;
  const revoked = await runOrderProcessingJob({
    kind: "order.process",
    connectionId: CONN,
    platform: "SHOPIFY",
    webhookEventId: claimRevoked.row.id,
  });
  if (revoked !== "SKIPPED" || reserveCalls !== 0) {
    throw new Error("key-revoked connection must not reserve an order");
  }
  if (syncLogs.rows.at(-1)?.message !== "connection_orders_disabled") {
    throw new Error("expected connection_orders_disabled after key revoke");
  }
  await connections.updateSyncFlags(CONN, {
    syncInventory: true,
    syncPrice: true,
    syncProducts: true,
    syncOrders: true,
  });

  // 8) reserve denied when qty 0 (409) — sanitized
  clearEntitlementCache();
  const claim409 = await webhooks.claim({
    connectionId: CONN,
    platform: "SHOPIFY",
    externalEventId: "evt-409",
    topic: "orders/create",
    payloadRef: rawBody,
  });
  setDeverpClientForTests(
    unusedClient({
      async reserveOrder() {
        throw new DeverpHttpError(
          409,
          `One or more items are no longer available. token=${SHPAT}`,
          {
            success: false,
            code: "stock_unavailable",
          },
        );
      },
    }),
  );
  const denied = await runOrderProcessingJob({
    kind: "order.process",
    connectionId: CONN,
    platform: "SHOPIFY",
    webhookEventId: claim409.row.id,
  });
  if (denied !== "FAILED") throw new Error(`expected FAILED, got ${denied}`);
  const deniedLog = syncLogs.rows.at(-1);
  if (deniedLog?.status !== "FAILED") {
    throw new Error("expected FAILED sync_log for denied reserve");
  }
  assertNoSecrets(JSON.stringify(deniedLog));

  // 9) not entitled design → 400 from Customer API reserve
  clearEntitlementCache();
  const claim400 = await webhooks.claim({
    connectionId: CONN,
    platform: "SHOPIFY",
    externalEventId: "evt-400",
    topic: "orders/create",
    payloadRef: rawBody,
  });
  setDeverpClientForTests(
    unusedClient({
      async reserveOrder() {
        throw new DeverpHttpError(
          400,
          "Design DJ-ORD is not entitled for this customer.",
          { success: false },
        );
      },
    }),
  );
  const notEntitled = await runOrderProcessingJob({
    kind: "order.process",
    connectionId: CONN,
    platform: "SHOPIFY",
    webhookEventId: claim400.row.id,
  });
  if (notEntitled !== "FAILED") {
    throw new Error(`expected FAILED for not entitled, got ${notEntitled}`);
  }
  assertNoSecrets(JSON.stringify(syncLogs.rows.at(-1)));

  // 10) success path when can_place_orders=true
  clearEntitlementCache();
  const claimOk = await webhooks.claim({
    connectionId: CONN,
    platform: "SHOPIFY",
    externalEventId: "evt-2",
    topic: "orders/create",
    payloadRef: rawBody,
  });
  setDeverpClientForTests(
    unusedClient({
      async getEntitlements() {
        return baseEntitlements({ permissions: { can_place_orders: true } });
      },
      async reserveOrder(payload) {
        if (payload.external_order_id !== "gid://shopify/Order/9001") {
          throw new Error("unexpected external_order_id");
        }
        if (payload.customer_id !== 55) {
          throw new Error("customer_id must come from connection binding");
        }
        return {
          order_id: 42,
          order_number: "ORD1-INV",
          duplicate: false,
          platform: "SHOPIFY",
          external_order_id: payload.external_order_id,
          connection_id: payload.connection_id,
        };
      },
    }),
  );

  const ok = await runOrderProcessingJob({
    kind: "order.process",
    connectionId: CONN,
    platform: "SHOPIFY",
    webhookEventId: claimOk.row.id,
  });
  if (ok !== "SUCCESS") throw new Error(`expected SUCCESS, got ${ok}`);
  if (syncLogs.rows.at(-1)?.status !== "SUCCESS") {
    throw new Error("expected SUCCESS sync_log");
  }
  const processed = await webhooks.getById(claimOk.row.id);
  if (processed?.status !== "processed") {
    throw new Error("expected webhook_event status=processed");
  }

  setConnectionStoreForTests(null);
  setWebhookEventStoreForTests(null);
  setSyncLogStoreForTests(null);
  setDeverpClientForTests(null);
  setShopifyMetaStoreForTests(null);
  resetAdaptersForTests();
  resetAdaptersReadyForTests();
  delete process.env.CHANNELS_SHOPIFY_WEBHOOK_SECRET;
  delete process.env.CHANNELS_SECRET_orders_selfcheck;

  console.log("orders selfcheck ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
