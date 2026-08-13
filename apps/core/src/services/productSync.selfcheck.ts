/**
 * Per-design product sync selfcheck — create/update/delete + entitlement fan-out.
 * Run: npm run selfcheck:product-sync -w @devjewels-channels/core
 */
import { registerDefaultAdapters } from "../channels/registerAdapters";
import { resetAdaptersForTests } from "../channels/router";
import {
  createMemoryConnectionStore,
  getConnectionById,
  setConnectionStoreForTests,
  type ConnectionRow,
} from "./connections";
import {
  createMemoryProductMappingStore,
  setProductMappingStoreForTests,
} from "./productMappings";
import {
  createMemorySyncLogStore,
  setSyncLogStoreForTests,
} from "./syncLog";
import {
  createMemoryVariantMappingStore,
  setVariantMappingStoreForTests,
} from "./variantMappings";
import { setDeverpClientForTests, type DeverpClient } from "../integrations/deverp/client";
import { runProductSyncJob } from "./productSyncService";
import { fanOutEntitlementChanged } from "./entitlementFanOut";
import { clearEntitlementCache } from "./entitlements";
import {
  drainMemoryProductQueue,
  peekMemoryProductQueueDepth,
} from "./queue";
import { safeParseEventEnvelope, type EntitlementChangedEnvelope } from "./events";
import {
  createMemoryShopifyMetaStore,
  setShopifyMetaStoreForTests,
} from "../../../shopify/src/meta";
import { resetAdaptersReadyForTests } from "../workers/handlers";

const CONN_A = "55555555-5555-5555-5555-555555555555";
const CONN_B = "66666666-6666-6666-6666-666666666666";

function connectionA(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: CONN_A,
    platform: "SHOPIFY",
    name: "product-sync-selfcheck-a",
    is_active: true,
    credentials_secret_ref: "env:CHANNELS_SECRET_product_sync_selfcheck",
    customer_id: 7,
    markup_mode: "none",
    markup_value: 0,
    markup_bps: 0,
    sync_inventory: true,
    sync_price: true,
    sync_products: true,
    sync_orders: true,
    ...overrides,
  };
}

function connectionB(): ConnectionRow {
  return {
    id: CONN_B,
    platform: "SHOPIFY",
    name: "product-sync-selfcheck-b",
    is_active: true,
    credentials_secret_ref: "env:CHANNELS_SECRET_product_sync_b",
    customer_id: 8,
    markup_mode: "none",
    markup_value: 0,
    markup_bps: 0,
    sync_inventory: true,
    sync_price: true,
    sync_products: true,
    sync_orders: true,
  };
}

type EntState = {
  designNos: string[];
  keyPresent: boolean;
  canViewDesigns: boolean;
  canViewInventory: boolean;
  canPlaceOrders: boolean;
};

function mockDeverp(state: EntState): DeverpClient {
  return {
    async listCatalogDesigns() {
      throw new Error("unused");
    },
    async getProduct(designNo) {
      return { id: 1, design_no: designNo, titleline: "Synced Ring", totamt: "99" };
    },
    async getInventory(designNo) {
      return {
        design_no: designNo,
        job_no: null,
        available_count: 1,
        truncated: false,
        jobs: [{ design_no: designNo, job_no: "JOB-9", totamt: "99" }],
      };
    },
    async getPrice() {
      return {
        customer_id: 7,
        design_no: "PS-1",
        original_price: 99,
        final_price: 99,
        currency: "USD",
      };
    },
    async getEntitlements(customerId) {
      if (customerId === 8) {
        return {
          customer_id: 8,
          key_present: true,
          api_key_id: 2,
          permissions: {
            can_view_designs: true,
            can_view_inventory: true,
            can_view_prices: true,
            can_place_orders: true,
          },
          design_nos: ["PS-B1"],
          design_count: 1,
          design_nos_truncated: false,
        };
      }
      return {
        customer_id: 7,
        key_present: state.keyPresent,
        api_key_id: state.keyPresent ? 1 : null,
        permissions: {
          can_view_designs: state.canViewDesigns,
          can_view_inventory: state.canViewInventory,
          can_view_prices: true,
          can_place_orders: state.canPlaceOrders,
        },
        design_nos: state.designNos,
        design_count: state.designNos.length,
        design_nos_truncated: false,
      };
    },
    async checkEntitlements() {
      return { design_no: "x", entitled: [], count: 0 };
    },
    async reserveOrder() {
      throw new Error("unused");
    },
  };
}

function entitlementEvent(
  action: EntitlementChangedEnvelope["data"]["action"],
  customerId: number,
  designNos: string[] = [],
  eventId = `evt-${action}-${customerId}`,
): EntitlementChangedEnvelope {
  return {
    event_id: eventId,
    event_type: "catalog.entitlement_changed",
    occurred_at: "2026-08-12T21:00:00.000Z",
    data: {
      customer_id: customerId,
      action,
      design_nos: designNos,
    },
  };
}

function installShopifyFetch(calls: string[]): typeof fetch {
  return (async (_url, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push(body);
    if (body.includes("productCreate")) {
      return new Response(
        JSON.stringify({
          data: {
            productCreate: {
              product: {
                id: "gid://shopify/Product/99",
                variants: {
                  edges: [
                    {
                      node: {
                        id: "gid://shopify/ProductVariant/99",
                        sku: "JOB-9",
                        inventoryItem: { id: "gid://shopify/InventoryItem/99" },
                      },
                    },
                  ],
                },
              },
              userErrors: [],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (
      body.includes("productUpdate") ||
      body.includes("productVariantsBulkUpdate") ||
      body.includes("productVariantsBulkCreate")
    ) {
      return new Response(
        JSON.stringify({
          data: {
            productUpdate: {
              product: { id: "gid://shopify/Product/99" },
              userErrors: [],
            },
            productVariantsBulkUpdate: {
              productVariants: [
                {
                  id: "gid://shopify/ProductVariant/99",
                  sku: "JOB-9",
                  inventoryItem: { id: "gid://shopify/InventoryItem/99" },
                },
              ],
              userErrors: [],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (body.includes("productDelete")) {
      return new Response(
        JSON.stringify({
          data: {
            productDelete: {
              deletedProductId: "gid://shopify/Product/99",
              userErrors: [],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

async function main(): Promise<void> {
  process.env.CHANNELS_SECRET_product_sync_selfcheck = JSON.stringify({
    accessToken: "shpat_PRODUCT_SYNC",
    shopDomain: "product-sync.myshopify.com",
  });
  process.env.CHANNELS_SECRET_product_sync_b = JSON.stringify({
    accessToken: "shpat_PRODUCT_SYNC_B",
    shopDomain: "product-sync-b.myshopify.com",
  });
  delete process.env.PRODUCT_SYNC_QUEUE_URL;

  const entState: EntState = {
    designNos: ["PS-1"],
    keyPresent: true,
    canViewDesigns: true,
    canViewInventory: true,
    canPlaceOrders: false,
  };

  const productMaps = createMemoryProductMappingStore();
  const variantMaps = createMemoryVariantMappingStore();
  const syncLogs = createMemorySyncLogStore();
  const connections = createMemoryConnectionStore([connectionA(), connectionB()]);

  setProductMappingStoreForTests(productMaps);
  setVariantMappingStoreForTests(variantMaps);
  setSyncLogStoreForTests(syncLogs);
  setConnectionStoreForTests(connections);
  setDeverpClientForTests(mockDeverp(entState));
  setShopifyMetaStoreForTests(
    createMemoryShopifyMetaStore({
      shops: [
        { connection_id: CONN_A, shop_domain: "product-sync.myshopify.com" },
        { connection_id: CONN_B, shop_domain: "product-sync-b.myshopify.com" },
      ],
      locations: [],
    }),
  );
  resetAdaptersForTests();
  resetAdaptersReadyForTests();
  registerDefaultAdapters();
  drainMemoryProductQueue();
  clearEntitlementCache();

  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = installShopifyFetch(calls);

  try {
    // --- Create then update ---
    const created = await runProductSyncJob({
      kind: "product.sync",
      connectionId: CONN_A,
      platform: "SHOPIFY",
      designNo: "PS-1",
    });
    if (created !== "CREATED") {
      throw new Error(`expected CREATED, got ${created}`);
    }
    const mapped = await productMaps.getByDesign(CONN_A, "PS-1");
    if (!mapped) throw new Error("expected mapping after create");

    const updated = await runProductSyncJob({
      kind: "product.sync",
      connectionId: CONN_A,
      platform: "SHOPIFY",
      designNo: "PS-1",
    });
    if (updated !== "UPDATED") {
      throw new Error(`expected UPDATED, got ${updated}`);
    }
    if (!calls.some((c) => c.includes("productUpdate"))) {
      throw new Error("expected productUpdate GraphQL on second sync");
    }

    // Denied path: sync_products off
    setConnectionStoreForTests(
      createMemoryConnectionStore([
        connectionA({ sync_products: false }),
        connectionB(),
      ]),
    );
    const skipped = await runProductSyncJob({
      kind: "product.sync",
      connectionId: CONN_A,
      platform: "SHOPIFY",
      designNo: "PS-1",
    });
    if (skipped !== "SKIPPED") {
      throw new Error(`expected SKIPPED when sync_products=false, got ${skipped}`);
    }

    // Restore active sync_products for delete / fan-out
    setConnectionStoreForTests(
      createMemoryConnectionStore([connectionA(), connectionB()]),
    );

    // --- revoke → deleteProduct + mapping cleared ---
    const deleted = await runProductSyncJob({
      kind: "product.sync",
      connectionId: CONN_A,
      platform: "SHOPIFY",
      designNo: "PS-1",
      action: "delete",
    });
    if (deleted !== "DELETED") {
      throw new Error(`expected DELETED, got ${deleted}`);
    }
    if (!calls.some((c) => c.includes("productDelete"))) {
      throw new Error("expected productDelete GraphQL on revoke/delete");
    }
    if (await productMaps.getByDesign(CONN_A, "PS-1")) {
      throw new Error("mapping must be cleared after delete");
    }

    // Seed mappings for fan-out isolation tests
    await productMaps.upsert({
      connectionId: CONN_A,
      designNo: "PS-1",
      externalProductId: "gid://shopify/Product/99",
    });
    await productMaps.upsert({
      connectionId: CONN_A,
      designNo: "PS-2",
      externalProductId: "gid://shopify/Product/100",
    });
    await productMaps.upsert({
      connectionId: CONN_B,
      designNo: "PS-B1",
      externalProductId: "gid://shopify/Product/200",
    });

    // --- grant → sync jobs for listed designs only (customer A) ---
    drainMemoryProductQueue();
    const grant = await fanOutEntitlementChanged(
      entitlementEvent("grant", 7, ["PS-1", "PS-NEW"]),
    );
    if (grant.enqueued !== 2) {
      throw new Error(`grant expected 2 jobs, got ${grant.enqueued}`);
    }
    const grantJobs = drainMemoryProductQueue();
    if (
      grantJobs.length !== 2 ||
      !grantJobs.every((j) => j.connectionId === CONN_A && j.action !== "delete")
    ) {
      throw new Error(`grant jobs wrong: ${JSON.stringify(grantJobs)}`);
    }
    if (grantJobs.some((j) => j.connectionId === CONN_B)) {
      throw new Error("grant for A must not enqueue B");
    }

    // Grant outside feed → sync runs but skips create (Customer API SoT)
    entState.designNos = ["PS-1"];
    clearEntitlementCache();
    const outside = await runProductSyncJob({
      kind: "product.sync",
      connectionId: CONN_A,
      platform: "SHOPIFY",
      designNo: "PS-OUTSIDE",
    });
    if (outside !== "SKIPPED") {
      throw new Error(`grant outside feed expected SKIPPED, got ${outside}`);
    }
    if (await productMaps.getByDesign(CONN_A, "PS-OUTSIDE")) {
      throw new Error("outside-feed design must not create mapping");
    }

    // --- revoke → delete jobs for listed designs only ---
    drainMemoryProductQueue();
    const revoke = await fanOutEntitlementChanged(
      entitlementEvent("revoke", 7, ["PS-2"]),
    );
    if (revoke.enqueued !== 1) {
      throw new Error(`revoke expected 1 job, got ${revoke.enqueued}`);
    }
    const revokeJobs = drainMemoryProductQueue();
    if (
      revokeJobs.length !== 1 ||
      revokeJobs[0]?.designNo !== "PS-2" ||
      revokeJobs[0]?.action !== "delete" ||
      revokeJobs[0]?.connectionId !== CONN_A
    ) {
      throw new Error(`revoke jobs wrong: ${JSON.stringify(revokeJobs)}`);
    }
    const revokeOutcome = await runProductSyncJob(revokeJobs[0]!);
    if (revokeOutcome !== "DELETED") {
      throw new Error(`revoke delete expected DELETED, got ${revokeOutcome}`);
    }
    if (await productMaps.getByDesign(CONN_A, "PS-2")) {
      throw new Error("PS-2 mapping must be cleared after revoke");
    }
    if (!(await productMaps.getByDesign(CONN_A, "PS-1"))) {
      throw new Error("PS-1 must remain after revoke of PS-2 only");
    }
    if (!(await productMaps.getByDesign(CONN_B, "PS-B1"))) {
      throw new Error("customer B mapping must be untouched by A's revoke");
    }

    // --- key_revoked → delete ALL mapped designs for customer A only ---
    await productMaps.upsert({
      connectionId: CONN_A,
      designNo: "PS-2",
      externalProductId: "gid://shopify/Product/100",
    });
    drainMemoryProductQueue();
    const keyRevoked = await fanOutEntitlementChanged(
      entitlementEvent("key_revoked", 7, []),
    );
    if (keyRevoked.enqueued !== 2) {
      throw new Error(
        `key_revoked expected 2 delete jobs (PS-1, PS-2), got ${keyRevoked.enqueued}`,
      );
    }
    const keyJobs = drainMemoryProductQueue();
    if (
      keyJobs.length !== 2 ||
      !keyJobs.every((j) => j.connectionId === CONN_A && j.action === "delete")
    ) {
      throw new Error(`key_revoked jobs wrong: ${JSON.stringify(keyJobs)}`);
    }
    for (const job of keyJobs) {
      const outcome = await runProductSyncJob(job);
      if (outcome !== "DELETED") {
        throw new Error(`key_revoked delete expected DELETED, got ${outcome}`);
      }
    }
    const aLeft = await productMaps.listByConnection(CONN_A);
    if (aLeft.length !== 0) {
      throw new Error(`customer A mappings must be empty after key_revoked, got ${aLeft.length}`);
    }
    if (!(await productMaps.getByDesign(CONN_B, "PS-B1"))) {
      throw new Error("customer B must be untouched by A's key_revoked");
    }

    // --- permissions_changed → refresh sync flags from Customer API ---
    await productMaps.upsert({
      connectionId: CONN_A,
      designNo: "PS-1",
      externalProductId: "gid://shopify/Product/99",
    });
    await productMaps.upsert({
      connectionId: CONN_A,
      designNo: "PS-OLD",
      externalProductId: "gid://shopify/Product/101",
    });
    entState.designNos = ["PS-1"];
    entState.canPlaceOrders = false;
    entState.canViewInventory = false;
    clearEntitlementCache();
    drainMemoryProductQueue();
    const perms = await fanOutEntitlementChanged(
      entitlementEvent("permissions_changed", 7, []),
    );
    if (perms.enqueued < 1) {
      throw new Error(`permissions_changed expected reconcile jobs, got ${perms.enqueued}`);
    }
    const afterFlags = await getConnectionById(CONN_A);
    if (!afterFlags) throw new Error("connection A missing");
    if (afterFlags.sync_orders !== false) {
      throw new Error("permissions_changed must set sync_orders from can_place_orders=false");
    }
    if (afterFlags.sync_inventory !== false) {
      throw new Error(
        "permissions_changed must set sync_inventory from can_view_inventory=false",
      );
    }
    const permJobs = drainMemoryProductQueue();
    const deleteExtras = permJobs.filter(
      (j) => j.action === "delete" && j.designNo === "PS-OLD",
    );
    if (deleteExtras.length !== 1) {
      throw new Error(
        `permissions_changed must delete mapped extras not in feed, got ${JSON.stringify(permJobs)}`,
      );
    }

    // --- Event without customer_id fails closed at envelope parse (no crash) ---
    const missingCustomer = safeParseEventEnvelope({
      event_id: "evt-missing-customer",
      event_type: "catalog.entitlement_changed",
      occurred_at: "2026-08-12T21:00:00.000Z",
      data: {
        action: "grant",
        design_nos: ["PS-1"],
      },
    });
    if (missingCustomer.success) {
      throw new Error("envelope without customer_id must fail parse");
    }
    if (peekMemoryProductQueueDepth() !== 0) {
      throw new Error("failed parse must not enqueue jobs");
    }

    // --- Unknown action fails closed (no deletes) ---
    const beforeUnknown = await productMaps.listByConnection(CONN_B);
    drainMemoryProductQueue();
    const unknown = await fanOutEntitlementChanged({
      event_id: "evt-unknown",
      event_type: "catalog.entitlement_changed",
      occurred_at: "2026-08-12T21:00:00.000Z",
      data: {
        customer_id: 8,
        action: "not_a_real_action" as EntitlementChangedEnvelope["data"]["action"],
        design_nos: ["PS-B1"],
      },
    });
    if (unknown.enqueued !== 0) {
      throw new Error(`unknown action must enqueue 0, got ${unknown.enqueued}`);
    }
    if (peekMemoryProductQueueDepth() !== 0) {
      throw new Error("unknown action must not enqueue product jobs");
    }
    const afterUnknown = await productMaps.listByConnection(CONN_B);
    if (afterUnknown.length !== beforeUnknown.length) {
      throw new Error("unknown action must not mutate mappings");
    }
  } finally {
    globalThis.fetch = originalFetch;
    setConnectionStoreForTests(null);
    setProductMappingStoreForTests(null);
    setVariantMappingStoreForTests(null);
    setSyncLogStoreForTests(null);
    setDeverpClientForTests(null);
    setShopifyMetaStoreForTests(null);
    resetAdaptersForTests();
    resetAdaptersReadyForTests();
    drainMemoryProductQueue();
    clearEntitlementCache();
  }

  console.log("product sync selfcheck ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
