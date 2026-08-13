/**
 * Inventory entitlement / sync selfcheck (memory stores + mock Shopify HTTP).
 * Covers Task 4: immediate qty on create; can_view_inventory / feed / customer_id
 * denials; fan-out only entitled mappings; rate-limit + token redaction.
 *
 * Run: npm run selfcheck:inventory -w @devjewels-channels/core
 */
import { registerDefaultAdapters } from "../channels/registerAdapters";
import { resetAdaptersForTests } from "../channels/router";
import {
  createMemoryConnectionStore,
  setConnectionStoreForTests,
  type ConnectionRow,
} from "./connections";
import {
  createMemorySyncLogStore,
  setSyncLogStoreForTests,
} from "./syncLog";
import {
  createMemoryVariantMappingStore,
  setVariantMappingStoreForTests,
} from "./variantMappings";
import {
  createMemoryProductMappingStore,
  setProductMappingStoreForTests,
} from "./productMappings";
import { runInventorySyncJob } from "./inventorySyncService";
import { runProductSyncJob } from "./productSyncService";
import {
  buildInventoryJobsForEntitledMappings,
  type VariantMappingRow,
} from "./inventoryFanOut";
import {
  setDeverpClientForTests,
  type DeverpClient,
} from "../integrations/deverp/client";
import { clearEntitlementCache } from "./entitlements";
import {
  drainMemoryInventoryQueue,
  peekMemoryInventoryQueueDepth,
} from "./queue";
import {
  createMemoryShopifyMetaStore,
  setShopifyMetaStoreForTests,
} from "../../../shopify/src/meta";
import { resetAdaptersReadyForTests } from "../workers/handlers";

const CONN = "33333333-3333-3333-3333-333333333333";
const CONN_B = "44444444-4444-4444-4444-444444444444";

type EntState = {
  designNos: string[];
  keyPresent: boolean;
  canViewDesigns: boolean;
  canViewInventory: boolean;
};

function baseConnection(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: CONN,
    platform: "SHOPIFY",
    name: "selfcheck",
    is_active: true,
    credentials_secret_ref: "env:CHANNELS_SECRET_inventory_selfcheck",
    customer_id: 42,
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

function mockDeverp(state: EntState): DeverpClient {
  return {
    async listCatalogDesigns() {
      throw new Error("unused");
    },
    async getProduct(designNo) {
      return {
        id: 1,
        design_no: designNo,
        titleline: "Inv Ring",
        totamt: "50",
      };
    },
    async getInventory(designNo) {
      return {
        design_no: designNo,
        job_no: null,
        available_count: 1,
        truncated: false,
        jobs: [{ design_no: designNo, job_no: "JOB-1", totamt: "50" }],
      };
    },
    async getPrice() {
      return {
        customer_id: 42,
        design_no: "SC-1",
        original_price: 50,
        final_price: 50,
        currency: "USD",
      };
    },
    async getEntitlements(customerId) {
      return {
        customer_id: customerId,
        key_present: state.keyPresent,
        api_key_id: state.keyPresent ? 1 : null,
        permissions: {
          can_view_designs: state.canViewDesigns,
          can_view_inventory: state.canViewInventory,
          can_view_prices: true,
          can_place_orders: false,
        },
        design_nos: state.designNos,
        design_count: state.designNos.length,
        design_nos_truncated: false,
      };
    },
    async checkEntitlements(input) {
      const entitled = [];
      for (const id of input.customerIds) {
        if (
          state.keyPresent &&
          state.canViewDesigns &&
          state.canViewInventory &&
          state.designNos.some(
            (n) =>
              n.trim().toUpperCase().replace(/\s+/g, "") ===
              input.designNo.trim().toUpperCase().replace(/\s+/g, ""),
          )
        ) {
          entitled.push({
            customer_id: id,
            permissions: {
              can_view_designs: true,
              can_view_inventory: true,
              can_view_prices: true,
              can_place_orders: false,
            },
          });
        }
      }
      return {
        design_no: input.designNo,
        entitled,
        count: entitled.length,
      };
    },
    async reserveOrder() {
      throw new Error("unused");
    },
  };
}

function seedMapping(): void {
  setVariantMappingStoreForTests(
    createMemoryVariantMappingStore([
      {
        id: "map-1",
        connection_id: CONN,
        design_no: "SC-1",
        job_no: "JOB-1",
        external_variant_id: "gid://shopify/ProductVariant/1",
        external_inventory_item_id: "gid://shopify/InventoryItem/1",
      },
    ]),
  );
}

async function withMockFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
  fn: () => Promise<void>,
): Promise<{ callCount: number }> {
  const original = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount += 1;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
  return { callCount };
}

function installShopifyProductFetch(): typeof fetch {
  return (async (_url, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("productCreate")) {
      return new Response(
        JSON.stringify({
          data: {
            productCreate: {
              product: {
                id: "gid://shopify/Product/1",
                variants: {
                  edges: [
                    {
                      node: {
                        id: "gid://shopify/ProductVariant/1",
                        sku: "JOB-1",
                        inventoryItem: {
                          id: "gid://shopify/InventoryItem/1",
                        },
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
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

async function main(): Promise<void> {
  process.env.CHANNELS_SECRET_inventory_selfcheck = JSON.stringify({
    accessToken: "shpat_SELFCHECK",
    shopDomain: "selfcheck.myshopify.com",
  });
  delete process.env.INVENTORY_SYNC_QUEUE_URL;
  delete process.env.PRODUCT_SYNC_QUEUE_URL;

  const entState: EntState = {
    designNos: ["SC-1"],
    keyPresent: true,
    canViewDesigns: true,
    canViewInventory: true,
  };

  const syncLogs = createMemorySyncLogStore();
  setSyncLogStoreForTests(syncLogs);
  setConnectionStoreForTests(createMemoryConnectionStore([baseConnection()]));
  seedMapping();
  setProductMappingStoreForTests(createMemoryProductMappingStore());
  setDeverpClientForTests(mockDeverp(entState));
  clearEntitlementCache();
  setShopifyMetaStoreForTests(
    createMemoryShopifyMetaStore({
      shops: [{ connection_id: CONN, shop_domain: "selfcheck.myshopify.com" }],
      locations: [
        {
          connection_id: CONN,
          external_location_id: "gid://shopify/Location/1",
          name: "Primary",
          is_primary: true,
        },
      ],
    }),
  );

  resetAdaptersForTests();
  resetAdaptersReadyForTests();
  registerDefaultAdapters();
  drainMemoryInventoryQueue();

  // 1) success → Shopify mutation + SUCCESS sync_log
  syncLogs.rows.length = 0;
  const ok = await withMockFetch(
    200,
    { data: { inventorySetQuantities: { userErrors: [] } } },
    {},
    async () => {
      const outcome = await runInventorySyncJob({
        kind: "inventory.sync",
        connectionId: CONN,
        platform: "SHOPIFY",
        designNo: "SC-1",
        jobNo: "JOB-1",
        quantity: 3,
      });
      if (outcome !== "SUCCESS") {
        throw new Error(`expected SUCCESS, got ${outcome}`);
      }
    },
  );
  if (ok.callCount !== 1) {
    throw new Error(`expected 1 Shopify call on success, got ${ok.callCount}`);
  }
  if (syncLogs.rows.at(-1)?.status !== "SUCCESS") {
    throw new Error("expected SUCCESS sync_log");
  }

  // 2) can_view_inventory=false → SKIPPED, no Shopify mutation
  entState.canViewInventory = false;
  clearEntitlementCache();
  syncLogs.rows.length = 0;
  const permOff = await withMockFetch(
    200,
    { data: { inventorySetQuantities: { userErrors: [] } } },
    {},
    async () => {
      const outcome = await runInventorySyncJob({
        kind: "inventory.sync",
        connectionId: CONN,
        platform: "SHOPIFY",
        designNo: "SC-1",
        jobNo: "JOB-1",
        quantity: 3,
      });
      if (outcome !== "SKIPPED") {
        throw new Error(`expected SKIPPED permission off, got ${outcome}`);
      }
    },
  );
  if (permOff.callCount !== 0) {
    throw new Error("permission off must not call Shopify");
  }
  if (syncLogs.rows.at(-1)?.message !== "not_entitled_inventory") {
    throw new Error("expected not_entitled_inventory when can_view_inventory=false");
  }

  // 3) design not in feed → SKIPPED, no mutation
  entState.canViewInventory = true;
  entState.designNos = ["OTHER"];
  clearEntitlementCache();
  syncLogs.rows.length = 0;
  const notInFeed = await withMockFetch(
    200,
    { data: { inventorySetQuantities: { userErrors: [] } } },
    {},
    async () => {
      const outcome = await runInventorySyncJob({
        kind: "inventory.sync",
        connectionId: CONN,
        platform: "SHOPIFY",
        designNo: "SC-1",
        jobNo: "JOB-1",
        quantity: 3,
      });
      if (outcome !== "SKIPPED") {
        throw new Error(`expected SKIPPED not in feed, got ${outcome}`);
      }
    },
  );
  if (notInFeed.callCount !== 0) {
    throw new Error("non-entitled design must not call Shopify");
  }
  if (syncLogs.rows.at(-1)?.message !== "not_entitled_inventory") {
    throw new Error("expected not_entitled_inventory when design not in feed");
  }

  // 4) connection without customer_id → SKIPPED
  entState.designNos = ["SC-1"];
  clearEntitlementCache();
  setConnectionStoreForTests(
    createMemoryConnectionStore([baseConnection({ customer_id: null })]),
  );
  syncLogs.rows.length = 0;
  const noCustomer = await withMockFetch(
    200,
    { data: { inventorySetQuantities: { userErrors: [] } } },
    {},
    async () => {
      const outcome = await runInventorySyncJob({
        kind: "inventory.sync",
        connectionId: CONN,
        platform: "SHOPIFY",
        designNo: "SC-1",
        jobNo: "JOB-1",
        quantity: 3,
      });
      if (outcome !== "SKIPPED") {
        throw new Error(`expected SKIPPED no customer_id, got ${outcome}`);
      }
    },
  );
  if (noCustomer.callCount !== 0) {
    throw new Error("missing customer_id must not call Shopify");
  }

  // Restore entitled connection for remaining cases
  setConnectionStoreForTests(createMemoryConnectionStore([baseConnection()]));
  clearEntitlementCache();

  // 5) 429 → RETRYING + throw
  syncLogs.rows.length = 0;
  let threw429 = false;
  await withMockFetch(429, "rate", { "Retry-After": "1" }, async () => {
    try {
      await runInventorySyncJob({
        kind: "inventory.sync",
        connectionId: CONN,
        platform: "SHOPIFY",
        designNo: "SC-1",
        jobNo: "JOB-1",
        quantity: 3,
      });
    } catch (err) {
      if (
        err &&
        typeof err === "object" &&
        "name" in err &&
        (err as { name: string }).name === "ShopifyRateLimitError"
      ) {
        threw429 = true;
      } else {
        throw err;
      }
    }
  });
  if (!threw429) throw new Error("expected rate limit throw");
  if (syncLogs.rows.at(-1)?.status !== "RETRYING") {
    throw new Error("expected RETRYING sync_log");
  }

  // 6) provider error message must redact shpat_ tokens (sync_log + console)
  syncLogs.rows.length = 0;
  {
    const original = globalThis.fetch;
    const originalError = console.error;
    const errorLines: string[] = [];
    console.error = ((...args: unknown[]) => {
      errorLines.push(args.map((a) => JSON.stringify(a)).join(" "));
    }) as typeof console.error;
    globalThis.fetch = (async () => {
      throw new Error("upstream failed shpat_LEAKEDTOKEN123 for shop");
    }) as typeof fetch;
    try {
      let threw = false;
      try {
        await runInventorySyncJob({
          kind: "inventory.sync",
          connectionId: CONN,
          platform: "SHOPIFY",
          designNo: "SC-1",
          jobNo: "JOB-1",
          quantity: 3,
        });
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("expected throw on provider error");
    } finally {
      globalThis.fetch = original;
      console.error = originalError;
    }
    if (errorLines.some((l) => l.includes("shpat_LEAKEDTOKEN123"))) {
      throw new Error(`token leaked in console.error: ${errorLines.join(" | ")}`);
    }
  }
  const failMsg = syncLogs.rows.at(-1)?.message ?? "";
  if (failMsg.includes("shpat_LEAKEDTOKEN123")) {
    throw new Error(`token leaked in sync_log: ${failMsg}`);
  }
  if (!failMsg.includes("shpat_***")) {
    throw new Error(`expected redacted token in sync_log, got: ${failMsg}`);
  }

  // 7) missing mapping → SKIPPED
  setVariantMappingStoreForTests(createMemoryVariantMappingStore([]));
  syncLogs.rows.length = 0;
  const missing = await runInventorySyncJob({
    kind: "inventory.sync",
    connectionId: CONN,
    platform: "SHOPIFY",
    designNo: "SC-1",
    jobNo: "JOB-1",
    quantity: 3,
  });
  if (missing !== "SKIPPED") {
    throw new Error(`expected SKIPPED mapping, got ${missing}`);
  }
  if (syncLogs.rows.at(-1)?.message !== "missing_mapping") {
    throw new Error("expected missing_mapping message");
  }

  // 8) disabled connection → SKIPPED
  setConnectionStoreForTests(
    createMemoryConnectionStore([baseConnection({ is_active: false })]),
  );
  seedMapping();
  syncLogs.rows.length = 0;
  const disabled = await runInventorySyncJob({
    kind: "inventory.sync",
    connectionId: CONN,
    platform: "SHOPIFY",
    designNo: "SC-1",
    jobNo: "JOB-1",
    quantity: 3,
  });
  if (disabled !== "SKIPPED") {
    throw new Error(`expected SKIPPED disabled, got ${disabled}`);
  }
  if (syncLogs.rows.at(-1)?.message !== "connection_disabled") {
    throw new Error("expected connection_disabled message");
  }

  // 9) Fan-out pure filter: only entitled customer mappings
  const mappings: VariantMappingRow[] = [
    {
      connection_id: CONN,
      platform: "SHOPIFY",
      design_no: "SC-1",
      job_no: "JOB-1",
      customer_id: 42,
    },
    {
      connection_id: CONN_B,
      platform: "SHOPIFY",
      design_no: "SC-1",
      job_no: "JOB-1",
      customer_id: 99,
    },
    {
      connection_id: "55555555-5555-5555-5555-555555555555",
      platform: "SHOPIFY",
      design_no: "SC-1",
      job_no: "JOB-1",
      customer_id: null,
    },
  ];
  const jobs = buildInventoryJobsForEntitledMappings(
    mappings,
    new Set([42]),
    "SC-1",
    "JOB-1",
    7,
  );
  if (jobs.length !== 1 || jobs[0]?.connectionId !== CONN) {
    throw new Error(
      `fan-out must enqueue only entitled connection, got ${JSON.stringify(jobs)}`,
    );
  }
  if (jobs[0]?.quantity !== 7) {
    throw new Error("fan-out must pass event quantity");
  }

  // 10) Product create → immediate inventory.sync enqueue (not wait for cron)
  setConnectionStoreForTests(createMemoryConnectionStore([baseConnection()]));
  setProductMappingStoreForTests(createMemoryProductMappingStore());
  setVariantMappingStoreForTests(createMemoryVariantMappingStore([]));
  entState.designNos = ["SC-1"];
  entState.canViewInventory = true;
  clearEntitlementCache();
  drainMemoryInventoryQueue();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = installShopifyProductFetch();
  try {
    const created = await runProductSyncJob({
      kind: "product.sync",
      connectionId: CONN,
      platform: "SHOPIFY",
      designNo: "SC-1",
    });
    if (created !== "CREATED") {
      throw new Error(`expected CREATED for immediate inventory, got ${created}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  const depth = peekMemoryInventoryQueueDepth();
  if (depth < 1) {
    throw new Error("product create must enqueue inventory.sync immediately");
  }
  const invJobs = drainMemoryInventoryQueue();
  const qtyJob = invJobs.find((j) => j.jobNo === "JOB-1");
  if (!qtyJob || qtyJob.quantity !== 1) {
    throw new Error(
      `expected immediate qty=1 for JOB-1, got ${JSON.stringify(invJobs)}`,
    );
  }

  // 11) can_view_inventory=false on create → no inventory enqueue
  entState.canViewInventory = false;
  clearEntitlementCache();
  setProductMappingStoreForTests(createMemoryProductMappingStore());
  setVariantMappingStoreForTests(createMemoryVariantMappingStore([]));
  drainMemoryInventoryQueue();
  globalThis.fetch = installShopifyProductFetch();
  try {
    const createdNoInv = await runProductSyncJob({
      kind: "product.sync",
      connectionId: CONN,
      platform: "SHOPIFY",
      designNo: "SC-1",
    });
    if (createdNoInv !== "CREATED") {
      throw new Error(`expected CREATED without inventory perm, got ${createdNoInv}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  if (peekMemoryInventoryQueueDepth() !== 0) {
    throw new Error("can_view_inventory=false must not enqueue inventory on create");
  }

  setConnectionStoreForTests(null);
  setVariantMappingStoreForTests(null);
  setProductMappingStoreForTests(null);
  setSyncLogStoreForTests(null);
  setShopifyMetaStoreForTests(null);
  setDeverpClientForTests(null);
  clearEntitlementCache();
  resetAdaptersForTests();
  resetAdaptersReadyForTests();

  console.log("inventory sync selfcheck ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
