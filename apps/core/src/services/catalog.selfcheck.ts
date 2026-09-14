/**
 * Catalog import selfcheck — mocked Django + Shopify HTTP (no real network/DB).
 * Entitlement grant/revoke/key_revoked fan-out lives in productSync.selfcheck.ts.
 * Run: npm run selfcheck:catalog -w @devjewels-channels/core
 */
import { createHmac } from "node:crypto";
import { registerDefaultAdapters } from "../channels/registerAdapters";
import { resetAdaptersForTests } from "../channels/router";
import {
  createMemoryConnectionStore,
  setConnectionStoreForTests,
  type ConnectionRow,
} from "./connections";
import {
  createMemoryCatalogImportStore,
  setCatalogImportStoreForTests,
} from "./catalogImportStore";
import {
  createMemoryProductMappingStore,
  setProductMappingStoreForTests,
} from "./productMappings";
import {
  createMemoryConnectionDesignMarkupStore,
  setConnectionDesignMarkupStoreForTests,
} from "./connectionDesignMarkups";
import {
  createMemorySyncLogStore,
  setSyncLogStoreForTests,
} from "./syncLog";
import {
  createMemoryVariantMappingStore,
  setVariantMappingStoreForTests,
} from "./variantMappings";
import { setDeverpClientForTests, type DeverpClient } from "../integrations/deverp/client";
import { runCatalogImport } from "./catalogImportService";
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

const CONN = "44444444-4444-4444-4444-444444444444";

function baseConnection(): ConnectionRow {
  return {
    id: CONN,
    platform: "SHOPIFY",
    name: "catalog-selfcheck",
    is_active: true,
    credentials_secret_ref: "env:CHANNELS_SECRET_catalog_selfcheck",
    customer_id: 1,
    markup_mode: "none",
    markup_value: 0,
    markup_bps: 0,
    sync_inventory: true,
    sync_price: true,
    sync_products: true,
    sync_orders: true,
  };
}

function mockDeverp(): DeverpClient {
  return {
    async listCatalogDesigns() {
      return {
        items: [
          { id: 1, design_no: "DJ-1", titleline: "Ring One", totamt: "100" },
          { id: 2, design_no: "DJ-2", titleline: "Ring Two", totamt: "200" },
        ],
        limit: 50,
        after_id: null,
        next_after_id: null,
        has_more: false,
        count: 2,
        customer_id: 1,
      };
    },
    async getProduct(designNo) {
      return { id: 1, design_no: designNo, titleline: designNo };
    },
    async getInventory(designNo) {
      if (designNo === "DJ-2") {
        return {
          design_no: designNo,
          job_no: null,
          available_count: 0,
          truncated: false,
          jobs: [],
        };
      }
      return {
        design_no: designNo,
        job_no: null,
        available_count: 1,
        truncated: false,
        jobs: [{ design_no: designNo, job_no: "JOB-1", totamt: "150" }],
      };
    },
    async getPrice() {
      return {
        customer_id: 1,
        design_no: "DJ-1",
        original_price: 100,
        final_price: 100,
        currency: "USD",
      };
    },
    async getEntitlements() {
      return {
        customer_id: 1,
        key_present: true,
        api_key_id: 1,
        permissions: {
          can_view_designs: true,
          can_view_inventory: true,
          can_view_prices: true,
          can_place_orders: false,
        },
        design_nos: ["DJ-1", "DJ-2"],
        design_count: 2,
        design_nos_truncated: false,
      };
    },
    async checkEntitlements(input) {
      return {
        design_no: input.designNo,
        entitled: [
          {
            customer_id: 1,
            permissions: {
              can_view_designs: true,
              can_view_inventory: true,
              can_view_prices: true,
              can_place_orders: false,
            },
          },
        ],
        count: 1,
      };
    },
    async reserveOrder() {
      throw new Error("unused");
    },
  };
}

async function main(): Promise<void> {
  process.env.CHANNELS_SECRET_catalog_selfcheck = JSON.stringify({
    accessToken: "shpat_CATALOG_SELFCHECK",
    shopDomain: "catalog.myshopify.com",
    webhookSecret: "whsec_catalog",
  });
  delete process.env.INVENTORY_SYNC_QUEUE_URL;
  drainMemoryInventoryQueue();

  const syncLogs = createMemorySyncLogStore();
  const productMaps = createMemoryProductMappingStore();
  const variantMaps = createMemoryVariantMappingStore();
  const imports = createMemoryCatalogImportStore();

  setSyncLogStoreForTests(syncLogs);
  setProductMappingStoreForTests(productMaps);
  setVariantMappingStoreForTests(variantMaps);
  setCatalogImportStoreForTests(imports);
  setConnectionDesignMarkupStoreForTests(createMemoryConnectionDesignMarkupStore());
  setConnectionStoreForTests(createMemoryConnectionStore([baseConnection()]));
  setDeverpClientForTests(mockDeverp());
  setShopifyMetaStoreForTests(
    createMemoryShopifyMetaStore({
      shops: [{ connection_id: CONN, shop_domain: "catalog.myshopify.com" }],
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

  const originalFetch = globalThis.fetch;
  const graphqlKind: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    // Media attach (must run before productCreate match — substring overlaps)
    if (
      body.includes("productMediaList") ||
      body.includes("productCreateMedia") ||
      body.includes("productDeleteMedia")
    ) {
      return new Response(
        JSON.stringify({
          data: {
            product: { id: "gid://shopify/Product/1", media: { nodes: [] } },
            productCreateMedia: { media: [], mediaUserErrors: [] },
            productDeleteMedia: { deletedMediaIds: [], mediaUserErrors: [] },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // productCreate GraphQL
    if (body.includes("productCreate($product")) {
      graphqlKind.push("create");
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
                        id: "gid://shopify/ProductVariant/11",
                        sku: "JOB-1",
                        inventoryItem: { id: "gid://shopify/InventoryItem/21" },
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
    if (body.includes("productVariantsBulkCreate")) {
      return new Response(
        JSON.stringify({
          data: {
            productVariantsBulkCreate: {
              productVariants: [
                {
                  id: "gid://shopify/ProductVariant/11",
                  sku: "JOB-1",
                  inventoryItem: { id: "gid://shopify/InventoryItem/21" },
                },
              ],
              userErrors: [],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // productUpdate / variants bulk (must not run on re-import skip)
    if (
      body.includes("productUpdate") ||
      body.includes("productVariantsBulkUpdate")
    ) {
      graphqlKind.push("update");
      return new Response(
        JSON.stringify({
          data: {
            productUpdate: {
              product: { id: "gid://shopify/Product/1" },
              userErrors: [],
            },
            productVariantsBulkUpdate: {
              productVariants: [
                {
                  id: "gid://shopify/ProductVariant/11",
                  sku: "JOB-1",
                  inventoryItem: { id: "gid://shopify/InventoryItem/21" },
                },
              ],
              userErrors: [],
            },
            productVariantsBulkCreate: {
              productVariants: [
                {
                  id: "gid://shopify/ProductVariant/11",
                  sku: "JOB-1",
                  inventoryItem: { id: "gid://shopify/InventoryItem/21" },
                },
              ],
              userErrors: [],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  try {
    const result = await runCatalogImport({
      connectionId: CONN,
      concurrency: 2,
      maxDesigns: 10,
    });
    if (result.status !== "completed") {
      throw new Error(`expected completed, got ${result.status}`);
    }
    if (result.processed !== 2) {
      throw new Error(`expected 2 processed (in-stock + OOS), got ${result.processed}`);
    }
    if (result.skipped !== 0) {
      throw new Error(`expected 0 skipped, got ${result.skipped}`);
    }
    const mapped = await productMaps.getByDesign(CONN, "DJ-1");
    if (!mapped || mapped.external_product_id !== "gid://shopify/Product/1") {
      throw new Error("expected product_mapping for DJ-1");
    }
    const oosMapped = await productMaps.getByDesign(CONN, "DJ-2");
    if (!oosMapped || oosMapped.external_product_id !== "gid://shopify/Product/1") {
      throw new Error("expected product_mapping for out-of-stock DJ-2");
    }
    const variant = await variantMaps.getByDesignJob(CONN, "DJ-1", "JOB-1");
    if (!variant?.external_inventory_item_id) {
      throw new Error("expected variant_mapping with inventory item id");
    }
    if (peekMemoryInventoryQueueDepth() !== 2) {
      throw new Error("catalog import must enqueue inventory for live job + OOS placeholder");
    }
    const firstInventoryJobs = drainMemoryInventoryQueue();
    const liveInv = firstInventoryJobs.find(
      (j) => j.designNo === "DJ-1" && j.jobNo === "JOB-1",
    );
    const oosInv = firstInventoryJobs.find(
      (j) => j.designNo === "DJ-2" && j.jobNo === "DJ-2",
    );
    if (liveInv?.quantity !== 1 || oosInv?.quantity !== 0) {
      throw new Error(
        `catalog import inventory job is wrong: ${JSON.stringify(firstInventoryJobs)}`,
      );
    }

    const createsAfterFirst = graphqlKind.filter((k) => k === "create").length;
    if (createsAfterFirst !== 2) {
      throw new Error(`expected 2 Shopify creates, got ${createsAfterFirst}`);
    }

    // Re-import must skip mapped designs (no duplicate create, no productUpdate).
    const result2 = await runCatalogImport({
      connectionId: CONN,
      concurrency: 2,
      maxDesigns: 10,
    });
    if (
      result2.status !== "completed" ||
      result2.processed !== 0 ||
      result2.skipped !== 2
    ) {
      throw new Error(
        `re-import expected 0 processed / 2 skipped, got ${JSON.stringify(result2)}`,
      );
    }
    const mapped2 = await productMaps.getByDesign(CONN, "DJ-1");
    if (!mapped2 || mapped2.external_product_id !== "gid://shopify/Product/1") {
      throw new Error("re-import should keep same product mapping");
    }
    if (peekMemoryInventoryQueueDepth() !== 0) {
      throw new Error("catalog re-import must not enqueue inventory for already-mapped designs");
    }
    if (graphqlKind.filter((k) => k === "create").length !== createsAfterFirst) {
      throw new Error("re-import must not call productCreate again");
    }
    if (graphqlKind.includes("update")) {
      throw new Error("re-import must not call productUpdate");
    }
    const skipLogs = syncLogs.rows.filter((r) => r.message === "already_exists");
    if (skipLogs.length < 2) {
      throw new Error("re-import must log already_exists for mapped designs");
    }

    // Full API-key revoke must deny manual/backfill imports before Shopify work.
    const revokedClient = mockDeverp();
    revokedClient.getEntitlements = async () => ({
      customer_id: 1,
      key_present: false,
      api_key_id: null,
      permissions: {
        can_view_designs: false,
        can_view_inventory: false,
        can_view_prices: false,
        can_place_orders: false,
      },
      design_nos: [],
      design_count: 0,
      design_nos_truncated: false,
    });
    setDeverpClientForTests(revokedClient);
    clearEntitlementCache();
    let importDenied = false;
    try {
      await runCatalogImport({
        connectionId: CONN,
        concurrency: 2,
        maxDesigns: 10,
      });
    } catch (err) {
      importDenied =
        err instanceof Error && err.message.includes("no active API key");
    }
    if (!importDenied) {
      throw new Error("catalog import must be denied after API-key revoke");
    }
    if ((await productMaps.listByConnection(CONN)).length !== 2) {
      throw new Error("denied import must not mutate existing mappings");
    }

    const failedLogs = syncLogs.rows.filter((r) => r.status === "FAILED");
    if (failedLogs.length) {
      throw new Error(`unexpected FAILED sync_log: ${failedLogs[0]?.message}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
    setConnectionStoreForTests(null);
    setCatalogImportStoreForTests(null);
    setProductMappingStoreForTests(null);
    setVariantMappingStoreForTests(null);
    setSyncLogStoreForTests(null);
    setConnectionDesignMarkupStoreForTests(null);
    setDeverpClientForTests(null);
    setShopifyMetaStoreForTests(null);
    resetAdaptersForTests();
    resetAdaptersReadyForTests();
    drainMemoryInventoryQueue();
    clearEntitlementCache();
  }

  // HMAC helper smoke (shared with orders selfcheck)
  const secret = "whsec";
  const raw = '{"id":1}';
  const digest = createHmac("sha256", secret).update(raw).digest("base64");
  const { verifyShopifyWebhookHmac } = await import("../../../shopify/src/webhooks");
  if (!verifyShopifyWebhookHmac({ rawBody: raw, hmacHeader: digest, secret })) {
    throw new Error("HMAC verify should pass");
  }
  if (verifyShopifyWebhookHmac({ rawBody: raw, hmacHeader: "bad", secret })) {
    throw new Error("HMAC verify should fail for bad header");
  }

  console.log("catalog import selfcheck ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
