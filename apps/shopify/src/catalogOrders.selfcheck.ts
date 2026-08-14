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
  const client = createShopifyClient({
    shopDomain: "x.myshopify.com",
    accessToken: "shpat_x",
    fetchImpl: (async (_url, init) => {
      calls.push(typeof init?.body === "string" ? init.body : "");
      const body = typeof init?.body === "string" ? init.body : "";
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

  const created = await createShopifyProduct(client, {
    connectionId: "c",
    designNo: "D1",
    title: "D1",
    variants: [{ jobNo: "JOB-A", price: 10, quantity: 1 }],
  });
  if (created.externalProductId !== "gid://shopify/Product/9") {
    throw new Error("product id mismatch");
  }
  if (created.variants[0]?.externalInventoryItemId !== "gid://shopify/InventoryItem/9") {
    throw new Error("inventory item id mismatch");
  }
  if (calls.length !== 2) throw new Error("expected create + variant graphql calls");

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

  console.log("shopify catalogOrders.selfcheck ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
