/**
 * End-to-end selfcheck for the Shopify live path:
 * 1) inventory job resolve (dedupe + drop placeholder)
 * 2) stale variant removal
 * 3) order line resolve via variant_mapping
 * 4) order.process → Django reserve mock (+ denied can_place_orders)
 *
 * Run: npm run selfcheck:shopify-live-e2e -w @devjewels-channels/core
 */
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
  setDeverpClientForTests,
  type DeverpClient,
  type DeverpEntitlements,
  type DeverpReserveOrderPayload,
  type DeverpReserveOrderResult,
} from "../integrations/deverp/client";
import { clearEntitlementCache } from "./entitlements";
import { runOrderProcessingJob } from "./orderProcessingService";
import {
  resolveChannelInventoryJobs,
  staleVariantMappingsToRemove,
} from "./channelInventoryJobs";
import { resolveChannelOrderLines } from "./channelOrderLineResolve";
import {
  createMemoryVariantMappingStore,
  setVariantMappingStoreForTests,
} from "./variantMappings";
import {
  createMemoryShopifyMetaStore,
  setShopifyMetaStoreForTests,
} from "../../../shopify/src/meta";
import { resetAdaptersReadyForTests } from "../workers/handlers";

const CONN = "e2e00000-0000-0000-0000-000000000001";
const WEBHOOK_SECRET = "whsec_e2e_live";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function baseEntitlements(
  overrides: Partial<DeverpEntitlements> & {
    permissions?: Partial<DeverpEntitlements["permissions"]>;
  } = {},
): DeverpEntitlements {
  return {
    customer_id: 42,
    key_present: overrides.key_present ?? true,
    api_key_id: overrides.api_key_id ?? 7,
    permissions: {
      can_view_designs: true,
      can_view_inventory: true,
      can_view_prices: true,
      can_place_orders: true,
      ...overrides.permissions,
    },
    design_nos: overrides.design_nos ?? ["E2E-RING"],
    design_count: overrides.design_count ?? 1,
    design_nos_truncated: overrides.design_nos_truncated ?? false,
  };
}

function unusedClient(
  overrides: Partial<DeverpClient> & {
    reserveOrder?: (
      payload: DeverpReserveOrderPayload,
    ) => Promise<DeverpReserveOrderResult>;
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

async function main(): Promise<void> {
  process.env.CHANNELS_SHOPIFY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.CHANNELS_SECRET_e2e = JSON.stringify({
    accessToken: "shpat_E2E",
    shopDomain: "e2e.myshopify.com",
    webhookSecret: WEBHOOK_SECRET,
  });

  // --- 1) Inventory: live jobs drop design_no placeholder + dedupe ---
  const resolved = resolveChannelInventoryJobs(
    "E2E-RING",
    [
      { job_no: "E2E-RING", totamt: "0" },
      { job_no: "JOB-LIVE", totamt: "100" },
      { job_no: "job-live", totamt: "999" },
    ],
    0,
  );
  assert(!resolved.outOfStock, "live stock");
  assert(resolved.jobs.length === 1, "dedupe + drop placeholder");
  assert(String(resolved.jobs[0]?.job_no) === "JOB-LIVE", "keep live job");

  const stale = staleVariantMappingsToRemove({
    designNo: "E2E-RING",
    desiredJobNos: ["JOB-LIVE"],
    mapped: [
      { jobNo: "E2E-RING", externalVariantId: "gid://shopify/ProductVariant/1" },
      { jobNo: "JOB-LIVE", externalVariantId: "gid://shopify/ProductVariant/2" },
      { jobNo: "OLD", externalVariantId: "gid://shopify/ProductVariant/3" },
    ],
  });
  assert(stale.length === 2, "remove placeholder + sold");

  // --- 2+3) Order: mapping resolve + reserve ---
  setVariantMappingStoreForTests(
    createMemoryVariantMappingStore([
      {
        id: "1",
        connection_id: CONN,
        design_no: "E2E-RING",
        job_no: "JOB-LIVE",
        external_variant_id: "gid://shopify/ProductVariant/88",
        external_inventory_item_id: "gid://shopify/InventoryItem/88",
      },
    ]),
  );

  const lines = await resolveChannelOrderLines({
    connectionId: CONN,
    payload: {
      id: 1001,
      line_items: [
        { id: 1, variant_id: 88, sku: "JOB-LIVE", quantity: 1 },
        { id: 2, sku: "MERCHANT-HAT", quantity: 1 },
      ],
    },
  });
  assert(lines.lines.length === 1, "only DJ line");
  assert(lines.lines[0]?.designNo === "E2E-RING", "design from mapping");
  assert(lines.skippedUnmapped === 1, "merchant skipped");

  const connections = createMemoryConnectionStore([
    {
      id: CONN,
      platform: "SHOPIFY",
      name: "e2e",
      credentials_secret_ref: "env:CHANNELS_SECRET_e2e",
      customer_id: 42,
      markup_mode: "none",
      markup_value: 0,
      markup_bps: 0,
      sync_inventory: true,
      sync_price: true,
      sync_products: true,
      sync_orders: true,
      is_active: true,
    },
  ]);
  setConnectionStoreForTests(connections);
  setShopifyMetaStoreForTests(
    createMemoryShopifyMetaStore({
      shops: [{ connection_id: CONN, shop_domain: "e2e.myshopify.com" }],
    }),
  );
  const webhooks = createMemoryWebhookEventStore();
  setWebhookEventStoreForTests(webhooks);
  const syncLogs = createMemorySyncLogStore();
  setSyncLogStoreForTests(syncLogs);
  clearEntitlementCache();
  resetAdaptersForTests();
  resetAdaptersReadyForTests();
  registerDefaultAdapters();

  let reserved = false;
  setDeverpClientForTests(
    unusedClient({
      async reserveOrder(payload) {
        assert(payload.lines.length === 1, "reserve one line");
        assert(payload.lines[0]?.design_no === "E2E-RING", "design");
        assert(payload.lines[0]?.job_no === "JOB-LIVE", "job");
        reserved = true;
        return {
          order_id: 1,
          order_number: "E2E-ORD1",
          duplicate: false,
          platform: "SHOPIFY",
          external_order_id: payload.external_order_id,
          connection_id: payload.connection_id,
        };
      },
    }),
  );

  const orderPayload = {
    id: 1001,
    admin_graphql_api_id: "gid://shopify/Order/1001",
    currency: "USD",
    email: "buyer@example.com",
    line_items: [
      { id: 1, variant_id: 88, sku: "JOB-LIVE", quantity: 1 },
      { id: 2, sku: "MERCHANT-HAT", quantity: 1 },
    ],
  };
  const rawBody = JSON.stringify(orderPayload);
  const claim = await webhooks.claim({
    connectionId: CONN,
    platform: "SHOPIFY",
    externalEventId: "e2e-evt-1",
    topic: "orders/create",
    payloadRef: rawBody,
  });

  const outcome = await runOrderProcessingJob({
    kind: "order.process",
    connectionId: CONN,
    platform: "SHOPIFY",
    webhookEventId: claim.row.id,
  });
  assert(outcome === "SUCCESS", `expected SUCCESS got ${outcome}`);
  assert(reserved, "reserveOrder called");

  // Denied path: can_place_orders false
  clearEntitlementCache();
  setDeverpClientForTests(
    unusedClient({
      async getEntitlements() {
        return baseEntitlements({ permissions: { can_place_orders: false } });
      },
    }),
  );
  const denyClaim = await webhooks.claim({
    connectionId: CONN,
    platform: "SHOPIFY",
    externalEventId: "e2e-evt-deny",
    topic: "orders/create",
    payloadRef: rawBody,
  });
  const denied = await runOrderProcessingJob({
    kind: "order.process",
    connectionId: CONN,
    platform: "SHOPIFY",
    webhookEventId: denyClaim.row.id,
  });
  assert(denied === "SKIPPED", `expected SKIPPED got ${denied}`);

  setConnectionStoreForTests(null);
  setWebhookEventStoreForTests(null);
  setSyncLogStoreForTests(null);
  setDeverpClientForTests(null);
  setShopifyMetaStoreForTests(null);
  setVariantMappingStoreForTests(null);
  resetAdaptersForTests();
  resetAdaptersReadyForTests();
  delete process.env.CHANNELS_SHOPIFY_WEBHOOK_SECRET;
  delete process.env.CHANNELS_SECRET_e2e;

  void syncLogs;
  console.log("shopifyLivePath.e2e.selfcheck OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
