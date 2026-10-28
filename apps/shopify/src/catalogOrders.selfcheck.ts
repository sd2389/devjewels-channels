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
      if (body.includes("productLiveState")) {
        const orphan = body.includes("Product/orphan");
        const suffix = orphan ? "orphan-a" : "9";
        return new Response(
          JSON.stringify({
            data: {
              product: {
                id: orphan ? "gid://shopify/Product/orphan" : "gid://shopify/Product/9",
                options: [{ id: "gid://shopify/ProductOption/1", name: "Job" }],
                variants: {
                  nodes: [
                    {
                      id: `gid://shopify/ProductVariant/${suffix}`,
                      sku: "JOB-A",
                      selectedOptions: [{ name: "Job", value: "JOB-A" }],
                      inventoryItem: { id: `gid://shopify/InventoryItem/${suffix}` },
                    },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (body.includes("productOptionsDelete") || body.includes("productOptionUpdate")) {
        return new Response(
          JSON.stringify({
            data: {
              productOptionsDelete: { userErrors: [] },
              productOptionUpdate: { userErrors: [] },
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
  if (calls[1]?.includes('"name":"Job"') || calls[1]?.includes("productOptions")) {
    throw new Error("single-variant create must leave the default variant so the picker stays hidden");
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
    // This block covers the opt-in path where DevJewels owns the storefront copy.
    syncProductContent: true,
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
  if (!calls.some((body) => body.includes("productOptionsDelete"))) {
    throw new Error("one piece in stock must remove the Job option so the storefront hides the picker");
  }

  const updatedNewJob = await updateShopifyProduct(client, {
    connectionId: "c",
    // This block covers the opt-in path where DevJewels owns the storefront copy.
    syncProductContent: true,
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

  await merchantEditedProductSelfcheck(updateShopifyProduct);
  await storefrontMetalCreateSelfcheck();
  await storefrontMetalUpdateSelfcheck();

  console.log("shopify catalogOrders.selfcheck ok");
}

/**
 * Two in-stock metals are the storefront picker. The job number stays on the SKU.
 */
async function storefrontMetalCreateSelfcheck(): Promise<void> {
  const calls: string[] = [];
  const client = createShopifyClient({
    shopDomain: "metal.myshopify.com",
    accessToken: "shpat_x",
    fetchImpl: (async (_url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push(body);
      if (body.includes("productsFindByDesign") || body.includes("products(first:")) {
        return new Response(JSON.stringify({ data: { products: { edges: [] } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          data: {
            productCreate: {
              product: {
                id: "gid://shopify/Product/70",
                variants: {
                  edges: [
                    {
                      node: {
                        id: "gid://shopify/ProductVariant/70",
                        sku: "31147",
                        inventoryItem: { id: "gid://shopify/InventoryItem/70" },
                      },
                    },
                  ],
                },
              },
              userErrors: [],
            },
            productVariantsBulkCreate: {
              productVariants: [
                {
                  id: "gid://shopify/ProductVariant/70",
                  sku: "31147",
                  inventoryItem: { id: "gid://shopify/InventoryItem/70" },
                },
                {
                  id: "gid://shopify/ProductVariant/71",
                  sku: "31148",
                  inventoryItem: { id: "gid://shopify/InventoryItem/71" },
                },
              ],
              userErrors: [],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch,
  });
  await createShopifyProduct(client, {
    connectionId: "c",
    designNo: "DR-941_OVL_5.00",
    title: "DR-941_OVL_5.00",
    variants: [
      {
        jobNo: "31147",
        price: 100,
        quantity: 1,
        details: { metal: "Gold", purity: "14K", color: "White" },
      },
      {
        jobNo: "31148",
        price: 110,
        quantity: 1,
        details: { metal: "Gold", purity: "18K", color: "Rose" },
      },
    ],
  });
  const created = calls.find((body) => body.includes("productCreate("));
  if (!created?.includes('"name":"Metal"')) {
    throw new Error("multi-piece create must send a Metal option");
  }
  if (!created.includes("14K White Gold") || !created.includes("18K Rose Gold")) {
    throw new Error("multi-piece create must use metal and karat as option values");
  }
  if (created.includes('"name":"31147"') || created.includes('"name":"31148"')) {
    throw new Error("job numbers must not be the storefront option values");
  }
  const variantsCall = calls.find((body) => body.includes("productVariantsBulkCreate"));
  if (!variantsCall?.includes("14K White Gold") || !variantsCall.includes('"sku":"31147"')) {
    throw new Error("variant write must label the option and keep the job number on the SKU");
  }
}

/**
 * A product already published with a Job option is rewritten on the next sync:
 * the option becomes Metal and the value becomes 14K White Gold. The SKU stays the job number.
 */
async function storefrontMetalUpdateSelfcheck(): Promise<void> {
  const calls: string[] = [];
  const client = createShopifyClient({
    shopDomain: "relabel.myshopify.com",
    accessToken: "shpat_x",
    fetchImpl: (async (_url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push(body);
      if (body.includes("productLiveState")) {
        return new Response(
          JSON.stringify({
            data: {
              product: {
                id: "gid://shopify/Product/80",
                options: [
                  {
                    id: "gid://shopify/ProductOption/80",
                    name: "Job",
                    // ProductOption.optionValues is a plain list in the schema.
                    optionValues: [
                      { id: "gid://shopify/ProductOptionValue/80", name: "31147" },
                    ],
                  },
                ],
                variants: {
                  nodes: [
                    {
                      id: "gid://shopify/ProductVariant/80",
                      sku: "31147",
                      selectedOptions: [{ name: "Job", value: "31147" }],
                      inventoryItem: { id: "gid://shopify/InventoryItem/80" },
                    },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            productUpdate: { product: { id: "gid://shopify/Product/80" }, userErrors: [] },
            productOptionUpdate: { userErrors: [] },
            productVariantsBulkUpdate: {
              productVariants: [
                {
                  id: "gid://shopify/ProductVariant/80",
                  sku: "31147",
                  inventoryItem: { id: "gid://shopify/InventoryItem/80" },
                },
              ],
              userErrors: [],
            },
            productVariantsBulkCreate: {
              productVariants: [
                {
                  id: "gid://shopify/ProductVariant/81",
                  sku: "31148",
                  inventoryItem: { id: "gid://shopify/InventoryItem/81" },
                },
              ],
              userErrors: [],
            },
            productVariantsBulkDelete: { userErrors: [] },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch,
  });
  const { updateShopifyProduct } = await import("./products");
  await updateShopifyProduct(client, {
    connectionId: "c",
    // This block covers the opt-in path where DevJewels owns the storefront copy.
    syncProductContent: true,
    designNo: "DR-941_OVL_5.00",
    title: "DR-941_OVL_5.00",
    externalProductId: "gid://shopify/Product/80",
    variants: [
      {
        jobNo: "31147",
        price: 100,
        quantity: 1,
        details: { metal: "Gold", purity: "14K", color: "White" },
      },
      {
        jobNo: "31148",
        price: 110,
        quantity: 1,
        details: { metal: "Rose Gold", purity: "18K", color: "Rose" },
      },
    ],
  });
  const relabel = calls.find((body) => body.includes("productOptionUpdate"));
  if (!relabel?.includes('"name":"Metal"') || !relabel.includes("14K White Gold")) {
    throw new Error("existing Job option must be renamed to Metal with the karat label");
  }
  const updatedPiece = calls.find(
    (body) => body.includes("productVariantsBulkUpdate") && body.includes("31147"),
  );
  if (!updatedPiece?.includes("14K White Gold") || !updatedPiece.includes('"sku":"31147"')) {
    throw new Error("updating a piece must rewrite the metal label and keep the job number as the SKU");
  }
  const created = calls.find((body) => body.includes("productVariantsBulkCreate"));
  if (!created?.includes("18K Rose Gold") || !created.includes('"sku":"31148"')) {
    throw new Error("new piece must be created under its metal label with the job SKU");
  }
  if (calls.some((body) => body.includes("productOptionsDelete"))) {
    throw new Error("two pieces must keep the Metal picker");
  }
}

/**
 * Merchant removed the Job option in Shopify admin: the product collapsed to one
 * "Default Title" variant and every saved variant id is gone. Update must restore
 * the option and rebuild variants, not fail on stale ids.
 */
async function merchantEditedProductSelfcheck(
  updateShopifyProduct: typeof import("./products").updateShopifyProduct,
): Promise<void> {
  const calls: string[] = [];
  let optionsRestored = false;
  const ok = (data: unknown) =>
    new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const client = createShopifyClient({
    shopDomain: "edited.myshopify.com",
    accessToken: "shpat_x",
    fetchImpl: (async (_url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push(body);
      if (body.includes("productLiveState")) {
        return ok({
          product: {
            id: "gid://shopify/Product/50",
            options: [{ name: optionsRestored ? "Job" : "Title" }],
            variants: {
              nodes: [
                {
                  id: "gid://shopify/ProductVariant/default",
                  sku: "",
                  selectedOptions: [
                    optionsRestored
                      ? { name: "Job", value: "J1" }
                      : { name: "Title", value: "Default Title" },
                  ],
                  inventoryItem: { id: "gid://shopify/InventoryItem/default" },
                },
              ],
            },
          },
        });
      }
      if (body.includes("productOptionsCreate")) {
        optionsRestored = true;
        return ok({ productOptionsCreate: { userErrors: [] } });
      }
      return ok({
        productUpdate: { product: { id: "gid://shopify/Product/50" }, userErrors: [] },
        productVariantsBulkUpdate: {
          productVariants: [
            {
              id: "gid://shopify/ProductVariant/default",
              sku: "J1",
              inventoryItem: { id: "gid://shopify/InventoryItem/default" },
            },
          ],
          userErrors: [],
        },
        productVariantsBulkCreate: {
          productVariants: [
            {
              id: "gid://shopify/ProductVariant/new-j2",
              sku: "J2",
              inventoryItem: { id: "gid://shopify/InventoryItem/new-j2" },
            },
          ],
          userErrors: [],
        },
        productVariantsBulkDelete: { userErrors: [] },
      });
    }) as typeof fetch,
  });

  const result = await updateShopifyProduct(client, {
    connectionId: "c",
    // This block covers the opt-in path where DevJewels owns the storefront copy.
    syncProductContent: true,
    designNo: "D50",
    title: "D50",
    externalProductId: "gid://shopify/Product/50",
    variants: [
      { jobNo: "J1", price: 10, quantity: 1 },
      { jobNo: "J2", price: 11, quantity: 1 },
    ],
    existingVariants: [
      { jobNo: "J1", externalVariantId: "gid://shopify/ProductVariant/stale-1" },
      { jobNo: "J2", externalVariantId: "gid://shopify/ProductVariant/stale-2" },
    ],
  });
  if (!optionsRestored) {
    throw new Error("update must restore the Job option the merchant removed");
  }
  if (calls.some((b) => b.includes("stale-1") || b.includes("stale-2"))) {
    throw new Error("update must not send saved variant ids that Shopify no longer has");
  }
  const byJob = Object.fromEntries(result.variants.map((v) => [v.jobNo, v.externalVariantId]));
  if (byJob.J1 !== "gid://shopify/ProductVariant/default") {
    throw new Error(`J1 should reuse the surviving variant: ${JSON.stringify(byJob)}`);
  }
  if (byJob.J2 !== "gid://shopify/ProductVariant/new-j2") {
    throw new Error(`J2 should be re-created: ${JSON.stringify(byJob)}`);
  }

  // Merchant added their own options.
  // Content sync ON (DevJewels owns the copy): fail with an actionable message
  // rather than guessing what the extra option should hold.
  // Content sync OFF (the default): the merchant is allowed to restructure, so
  // the sync must keep running and only report the pieces it cannot place.
  const custom = createShopifyClient({
    shopDomain: "custom.myshopify.com",
    accessToken: "shpat_x",
    fetchImpl: (async (_url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("productLiveState")) {
        return ok({
          product: {
            id: "gid://shopify/Product/51",
            options: [{ name: "Size" }],
            variants: { nodes: [{ id: "gid://shopify/ProductVariant/m1", sku: "" }] },
          },
        });
      }
      return ok({ productUpdate: { product: { id: "gid://shopify/Product/51" }, userErrors: [] } });
    }) as typeof fetch,
  });
  let message = "";
  try {
    await updateShopifyProduct(custom, {
      connectionId: "c",
      designNo: "D51",
      title: "D51",
      externalProductId: "gid://shopify/Product/51",
      syncProductContent: true,
      variants: [{ jobNo: "J9", price: 10, quantity: 1 }],
    });
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  if (!message.includes("options were changed")) {
    throw new Error(`expected options-changed error, got: ${message || "no error"}`);
  }

  let merchantOwnedError = "";
  try {
    await updateShopifyProduct(custom, {
      connectionId: "c",
      designNo: "D51",
      title: "D51",
      externalProductId: "gid://shopify/Product/51",
      variants: [{ jobNo: "J9", price: 10, quantity: 1 }],
    });
  } catch (err) {
    merchantOwnedError = err instanceof Error ? err.message : String(err);
  }
  if (merchantOwnedError) {
    throw new Error(
      `a merchant-restructured product must not break the sync, got: ${merchantOwnedError}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
