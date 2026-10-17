/**
 * Shopify catalog + orders helper selfcheck (HMAC + normalize + productCreate mock).
 * Run: npm run selfcheck:catalog-orders -w @devjewels-channels/shopify
 */
import { createHmac } from "node:crypto";
import { createShopifyClient } from "./client";
import { createShopifyProduct } from "./products";
import { normalizeShopifyOrder } from "./orders";
import { verifyShopifyWebhookHmac } from "./webhooks";

async function main(): Promise<void> {
  const secret = "shopify_hmac_secret";
  const raw = '{"hello":"world"}';
  const good = createHmac("sha256", secret).update(raw).digest("base64");
  if (!verifyShopifyWebhookHmac({ rawBody: raw, hmacHeader: good, secret })) {
    throw new Error("expected valid HMAC");
  }
  if (verifyShopifyWebhookHmac({ rawBody: raw, hmacHeader: "nope", secret })) {
    throw new Error("expected invalid HMAC");
  }

  const normalized = normalizeShopifyOrder(
    {
      id: 7,
      currency: "USD",
      line_items: [
        {
          id: 1,
          sku: "JOB-A",
          quantity: 1,
          properties: [{ name: "design_no", value: "D1" }],
        },
      ],
    },
    "conn-1",
  );
  if (normalized.externalOrderId !== "7") {
    throw new Error(`unexpected externalOrderId ${normalized.externalOrderId}`);
  }

  const calls: string[] = [];
  let findHits = 0;
  const client = createShopifyClient({
    shopDomain: "x.myshopify.com",
    accessToken: "shpat_x",
    fetchImpl: (async (_url, init) => {
      calls.push(typeof init?.body === "string" ? init.body : "");
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("productsFindByDesign") || body.includes("products(first:")) {
        findHits += 1;
        // First create: no existing product. Later reclaim test seeds a hit.
        const reclaim = findHits >= 2;
        return new Response(
          JSON.stringify({
            data: {
              products: {
                edges: reclaim
                  ? [
                      {
                        node: {
                          id: "gid://shopify/Product/orphan",
                          title: "D1",
                          createdAt: "2026-01-01T00:00:00Z",
                          totalVariants: 4,
                          metafield: { value: "D1" },
                        },
                      },
                    ]
                  : [],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (body.includes("productVariantsForReclaim")) {
        return new Response(
          JSON.stringify({
            data: {
              product: {
                id: "gid://shopify/Product/orphan",
                variants: {
                  nodes: [
                    {
                      id: "gid://shopify/ProductVariant/orphan-a",
                      sku: "JOB-A",
                      selectedOptions: [{ name: "Job", value: "JOB-A" }],
                      inventoryItem: { id: "gid://shopify/InventoryItem/orphan-a" },
                    },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (body.includes("productUpdate") || body.includes("productVariantsBulk")) {
        return new Response(
          JSON.stringify({
            data: {
              productUpdate: {
                product: { id: "gid://shopify/Product/9" },
                userErrors: [],
              },
              productVariantsBulkUpdate: {
                productVariants: [
                  {
                    id: "gid://shopify/ProductVariant/9",
                    sku: "JOB-A",
                    inventoryItem: { id: "gid://shopify/InventoryItem/9" },
                  },
                ],
                userErrors: [],
              },
              productVariantsBulkCreate: {
                productVariants: [
                  {
                    id: "gid://shopify/ProductVariant/9",
                    sku: "JOB-A",
                    inventoryItem: { id: "gid://shopify/InventoryItem/9" },
                  },
                ],
                userErrors: [],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            productCreate: {
              product: {
                id: "gid://shopify/Product/9",
                variants: {
                  edges: [
                    {
                      node: {
                        id: "gid://shopify/ProductVariant/9",
                        sku: "JOB-A",
                        inventoryItem: { id: "gid://shopify/InventoryItem/9" },
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
    }) as typeof fetch,
  });

  let earlyMapped: string | null = null;
  const created = await createShopifyProduct(client, {
    connectionId: "c",
    designNo: "D1",
    title: "D1",
    variants: [{ jobNo: "JOB-A", price: 10, quantity: 1 }],
    onExternalProductId: async (id) => {
      earlyMapped = id;
    },
  });
  if (created.externalProductId !== "gid://shopify/Product/9") {
    throw new Error("product id mismatch");
  }
  if (earlyMapped !== "gid://shopify/Product/9") {
    throw new Error("expected onExternalProductId before variants finish");
  }
  if (created.variants[0]?.externalInventoryItemId !== "gid://shopify/InventoryItem/9") {
    throw new Error("inventory item id mismatch");
  }
  // find + productCreate + variants
  if (calls.length !== 3) {
    throw new Error(`expected find+create+variant graphql calls, got ${calls.length}`);
  }
  if (!calls[1]?.includes('"name":"Job"') && !calls[1]?.includes("Job")) {
    throw new Error("single-variant create must still send a Job product option");
  }
  if (!calls[1]?.includes("dj_design:D1")) {
    throw new Error("create must attach design identity tag");
  }
  if (!calls[1]?.includes('"status":"DRAFT"')) {
    throw new Error("new products must be created as DRAFT");
  }

  // Retry path: existing orphan must update, not productCreate again.
  const createCallsBefore = calls.filter((b) => b.includes("productCreate(")).length;
  const reclaimed = await createShopifyProduct(client, {
    connectionId: "c",
    designNo: "D1",
    title: "D1",
    variants: [{ jobNo: "JOB-A", price: 10, quantity: 1 }],
  });
  if (reclaimed.externalProductId !== "gid://shopify/Product/orphan") {
    throw new Error("expected reclaim of existing Shopify product");
  }
  const createCallsAfter = calls.filter((b) => b.includes("productCreate(")).length;
  if (createCallsAfter !== createCallsBefore) {
    throw new Error("reclaim must not call productCreate again");
  }

  const { updateShopifyProduct } = await import("./products");
  const updated = await updateShopifyProduct(client, {
    connectionId: "c",
    designNo: "D1",
    title: "D1 Updated",
    externalProductId: "gid://shopify/Product/9",
    variants: [{ jobNo: "JOB-A", price: 12, quantity: 1 }],
    existingVariants: [
      {
        jobNo: "JOB-A",
        externalVariantId: "gid://shopify/ProductVariant/9",
        externalInventoryItemId: "gid://shopify/InventoryItem/9",
      },
    ],
  });
  if (updated.externalProductId !== "gid://shopify/Product/9") {
    throw new Error("update product id mismatch");
  }
  if (calls.length < 4) throw new Error("expected productUpdate graphql calls");
  const productUpdateCall = calls.find((body) => body.includes("productUpdate("));
  if (!productUpdateCall) throw new Error("expected a productUpdate call");
  if (productUpdateCall.includes('"status"')) {
    throw new Error("product update must not change Shopify publish status");
  }

  const updatedNewJob = await updateShopifyProduct(client, {
    connectionId: "c",
    designNo: "D1",
    title: "D1 Updated",
    externalProductId: "gid://shopify/Product/9",
    variants: [
      { jobNo: "JOB-A", price: 12, quantity: 1 },
      { jobNo: "JOB-B", price: 13, quantity: 1 },
    ],
    existingVariants: [
      {
        jobNo: "JOB-A",
        externalVariantId: "gid://shopify/ProductVariant/9",
        externalInventoryItemId: "gid://shopify/InventoryItem/9",
      },
    ],
  });
  if (updatedNewJob.variants.length < 1) {
    throw new Error("expected bulk-create of newly stocked job");
  }
  const createWithNewJob = calls.find(
    (body) => body.includes("productVariantsBulkCreate") && body.includes("JOB-B"),
  );
  if (!createWithNewJob?.includes("Job")) {
    throw new Error("adding a live job must send Job optionValues");
  }

  console.log("shopify catalogOrders.selfcheck ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
