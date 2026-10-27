/**
 * Merchant-owned catalog selfcheck — the sync may touch live stock and nothing else.
 *
 * Locks the contract behind connection.sync_product_content (default false):
 * titles, descriptions, selling prices, tags, images, product status and the
 * product's option structure belong to the merchant; which pieces exist, their
 * quantity and their wholesale cost belong to DevJewels.
 *
 * Run: npm run selfcheck:merchant-catalog -w @devjewels-channels/shopify
 */
import type { ShopifyAdminClient } from "./client";
import {
  createShopifyProduct,
  newVariantOptionValues,
  planLiveStockVariantSync,
  updateShopifyProduct,
} from "./products";

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok  ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Mutations that write something the merchant owns. None may ever be sent. */
const MERCHANT_OWNED_MUTATIONS = [
  "productUpdate",
  "productCreateMedia",
  "productDeleteMedia",
  "productOptionUpdate",
  "productOptionsCreate",
  "productOptionsDelete",
  "productDelete",
];

type LiveVariantSeed = {
  id: string;
  sku: string;
  price: string;
  options: Array<{ name: string; value: string }>;
};

type Recorded = { op: string; query: string; variables: Record<string, unknown> };

function operationName(query: string): string {
  return /mutation\s+(\w+)|query\s+(\w+)/.exec(query)?.slice(1).find(Boolean) ?? "unknown";
}

function fakeClient(seed: {
  options: Array<{ name: string; values: string[] }>;
  variants: LiveVariantSeed[];
  findsProductId?: string;
}): { client: ShopifyAdminClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const client: ShopifyAdminClient = {
    shopDomain: "merchant.myshopify.com",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    graphql: (async (query: string, variables?: Record<string, unknown>) => {
      const op = operationName(query);
      calls.push({ op, query, variables: variables ?? {} });
      switch (op) {
        case "productLiveState":
          return {
            data: {
              product: {
                id: "gid://shopify/Product/1",
                options: seed.options.map((o, i) => ({
                  id: `gid://shopify/ProductOption/${i}`,
                  name: o.name,
                  // ProductOption.optionValues is [ProductOptionValue!]! —
                  // a plain list, not a paginated connection.
                  optionValues: o.values.map((v, j) => ({
                    id: `gid://shopify/ProductOptionValue/${i}-${j}`,
                    name: v,
                  })),
                })),
                variants: {
                  nodes: seed.variants.map((v) => ({
                    id: v.id,
                    sku: v.sku,
                    price: v.price,
                    selectedOptions: v.options,
                    inventoryItem: { id: `${v.id}/inv` },
                  })),
                },
              },
            },
          };
        case "productsFindByDesign":
          return {
            data: {
              products: {
                edges: seed.findsProductId
                  ? [
                      {
                        node: {
                          id: seed.findsProductId,
                          title: "Heart Bezel Diamond Studs",
                          createdAt: "2026-01-01T00:00:00Z",
                          totalVariants: seed.variants.length,
                          metafield: { value: "DE-093" },
                        },
                      },
                    ]
                  : [],
              },
            },
          };
        case "productVariantsBulkCreate": {
          const wanted = (variables?.variants ?? []) as Array<{
            inventoryItem?: { sku?: string };
          }>;
          return {
            data: {
              productVariantsBulkCreate: {
                productVariants: wanted.map((v, i) => ({
                  id: `gid://shopify/ProductVariant/new-${i}`,
                  sku: v.inventoryItem?.sku ?? "",
                  inventoryItem: { id: `gid://shopify/InventoryItem/new-${i}` },
                })),
                userErrors: [],
              },
            },
          };
        }
        case "productVariantsBulkUpdate": {
          const wanted = (variables?.variants ?? []) as Array<{ id?: string }>;
          return {
            data: {
              productVariantsBulkUpdate: {
                productVariants: wanted.map((v) => ({
                  id: v.id ?? "gid://shopify/ProductVariant/x",
                  sku: "",
                  inventoryItem: { id: `${v.id}/inv` },
                })),
                userErrors: [],
              },
            },
          };
        }
        case "productVariantsBulkDelete":
          return { data: { productVariantsBulkDelete: { userErrors: [] } } };
        case "productOptionsCreate": {
          const created = (variables?.options ?? []) as Array<{
            name: string;
            values?: Array<{ name: string }>;
          }>;
          for (const option of created) {
            seed.options.push({
              name: option.name,
              values: (option.values ?? []).map((v) => v.name),
            });
          }
          return { data: { productOptionsCreate: { userErrors: [] } } };
        }
        case "productUpdate":
          return { data: { productUpdate: { product: { id: "gid://shopify/Product/1" }, userErrors: [] } } };
        default:
          return { data: {} };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  };
  return { client, calls };
}

/** The merchant's product: their title, their prices, one Metal picker. */
function merchantProduct() {
  return fakeClient({
    options: [{ name: "Metal", values: ["14K White Gold", "18K Rose Gold"] }],
    variants: [
      {
        id: "gid://shopify/ProductVariant/100",
        sku: "DE-093_B2.00",
        price: "1400.00",
        options: [{ name: "Metal", value: "14K White Gold" }],
      },
      {
        id: "gid://shopify/ProductVariant/200",
        sku: "DE-093_B3.00",
        price: "1400.00",
        options: [{ name: "Metal", value: "18K Rose Gold" }],
      },
    ],
  });
}

function job(jobNo: string, overrides: Record<string, unknown> = {}) {
  return {
    jobNo,
    sku: jobNo,
    price: 480,
    wholesaleCost: 320,
    quantity: 1,
    details: { metal: "Gold", purity: "14K", color: "W" },
    ...overrides,
  };
}

function updateInput(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: "11111111-1111-1111-1111-111111111111",
    designNo: "DE-093",
    title: "DE-093",
    externalProductId: "gid://shopify/Product/1",
    imageUrls: ["https://cdn.example.com/de-093.jpg"],
    productType: "Earrings",
    tags: ["studs"],
    variants: [job("DE-093_B2.00"), job("DE-093_B3.00")],
    existingVariants: [
      { jobNo: "DE-093_B2.00", externalVariantId: "gid://shopify/ProductVariant/100" },
      { jobNo: "DE-093_B3.00", externalVariantId: "gid://shopify/ProductVariant/200" },
    ],
    ...overrides,
  };
}

async function main(): Promise<void> {
  console.log("plan: live stock decides the variant set");

  const sold = planLiveStockVariantSync({
    live: [
      { jobNo: "J1", optionValue: "14K", externalVariantId: "v1", selectedOptions: [] },
      { jobNo: "J2", optionValue: "18K", externalVariantId: "v2", selectedOptions: [] },
    ],
    desiredJobNos: ["J1"],
    ownedJobNos: ["J1", "J2"],
  });
  check("sold piece is removed", sold.remove.map((v) => v.jobNo).join() === "J2");
  check("remaining piece is kept", sold.keep.map((k) => k.jobNo).join() === "J1");
  check("nothing is created", sold.create.length === 0);

  const added = planLiveStockVariantSync({
    live: [{ jobNo: "J1", optionValue: "14K", externalVariantId: "v1", selectedOptions: [] }],
    desiredJobNos: ["J1", "J9"],
    ownedJobNos: ["J1"],
  });
  check("new piece is created", added.create.join() === "J9");
  check("existing piece is not re-created", added.remove.length === 0);

  const merchantMade = planLiveStockVariantSync({
    live: [
      { jobNo: "J1", optionValue: "14K", externalVariantId: "v1", selectedOptions: [] },
      { jobNo: "MERCH-SKU", optionValue: "Custom", externalVariantId: "v2", selectedOptions: [] },
      { jobNo: "", optionValue: "No SKU", externalVariantId: "v3", selectedOptions: [] },
    ],
    desiredJobNos: ["J1"],
    ownedJobNos: ["J1"],
  });
  check(
    "a variant the merchant added is never removed",
    merchantMade.remove.length === 0 && merchantMade.zero.length === 0,
  );

  const lastOne = planLiveStockVariantSync({
    live: [{ jobNo: "J1", optionValue: "14K", externalVariantId: "v1", selectedOptions: [] }],
    desiredJobNos: [],
    ownedJobNos: ["J1"],
  });
  check("the last variant is zeroed, not deleted", lastOne.remove.length === 0);
  check("the last variant is reported for zeroing", lastOne.zero.map((v) => v.jobNo).join() === "J1");

  console.log("update: content sync off");

  const off = merchantProduct();
  await updateShopifyProduct(off.client, updateInput() as never);
  const offOps = off.calls.map((c) => c.op);
  for (const mutation of MERCHANT_OWNED_MUTATIONS) {
    check(`never sends ${mutation}`, !offOps.includes(mutation), offOps.join(", "));
  }
  // Piece details are refreshed on variants already there, but that update is
  // allowed to carry metafields and nothing else.
  const offUpdates = off.calls
    .filter((c) => c.op === "productVariantsBulkUpdate")
    .flatMap((c) => (c.variables.variants ?? []) as Array<Record<string, unknown>>);
  check(
    "never rewrites the price of a piece already on the product",
    offUpdates.every((v) => !("price" in v)),
    JSON.stringify(offUpdates),
  );
  check(
    "never rewrites the SKU of a piece already on the product",
    offUpdates.every((v) => !("inventoryItem" in v)),
    JSON.stringify(offUpdates),
  );
  check(
    "piece details are refreshed, not left to go stale",
    offUpdates.length === 2 &&
      offUpdates.every(
        (v) => Array.isArray(v.metafields) && (v.metafields as unknown[]).length > 0,
      ),
    JSON.stringify(offUpdates),
  );
  const refreshedKeys = (
    (offUpdates[0]?.metafields ?? []) as Array<{ key: string; namespace: string }>
  ).map((m) => m.key);
  check(
    "the refresh carries the stock-table fields",
    ["job_no", "metal", "purity", "color"].every((k) => refreshedKeys.includes(k)),
    refreshedKeys.join(", "),
  );

  const soldOut = merchantProduct();
  const soldResult = await updateShopifyProduct(
    soldOut.client,
    updateInput({
      variants: [job("DE-093_B2.00")],
      existingVariants: [
        { jobNo: "DE-093_B2.00", externalVariantId: "gid://shopify/ProductVariant/100" },
      ],
      removeVariants: [
        { jobNo: "DE-093_B3.00", externalVariantId: "gid://shopify/ProductVariant/200" },
      ],
    }) as never,
  );
  const deleteCall = soldOut.calls.find((c) => c.op === "productVariantsBulkDelete");
  check(
    "a sold piece is deleted from Shopify",
    Boolean(deleteCall) &&
      JSON.stringify(deleteCall?.variables.variantsIds) ===
        JSON.stringify(["gid://shopify/ProductVariant/200"]),
    JSON.stringify(deleteCall?.variables),
  );
  check(
    "live ids are handed back so stale mappings heal",
    soldResult.variants.some(
      (v) =>
        v.jobNo === "DE-093_B2.00" &&
        v.externalInventoryItemId === "gid://shopify/ProductVariant/100/inv",
    ),
    JSON.stringify(soldResult.variants),
  );

  const arrived = merchantProduct();
  await updateShopifyProduct(
    arrived.client,
    updateInput({
      variants: [
        job("DE-093_B2.00"),
        job("DE-093_B3.00"),
        job("DE-093_B4.00", { details: { metal: "Gold", purity: "18K", color: "Y" } }),
      ],
    }) as never,
  );
  const createCall = arrived.calls.find((c) => c.op === "productVariantsBulkCreate");
  const createdVariants = (createCall?.variables.variants ?? []) as Array<{
    price?: string;
    inventoryItem?: { sku?: string };
    optionValues?: Array<{ optionName: string; name: string }>;
  }>;
  check("a new piece is added", createdVariants.length === 1, JSON.stringify(createdVariants));
  check(
    "the new piece inherits the merchant's price, not ours",
    createdVariants[0]?.price === "1400.00",
    String(createdVariants[0]?.price),
  );
  check(
    "the new piece carries the job number on SKU, not in the picker",
    createdVariants[0]?.inventoryItem?.sku === "DE-093_B4.00" &&
      createdVariants[0]?.optionValues?.[0]?.name === "18K Yellow Gold",
    JSON.stringify(createdVariants[0]?.optionValues),
  );

  console.log("the design sells out");

  // Every piece gone. The product must survive with nothing buyable, and the
  // picker must not be replaced by a bare design code.
  const soldOutDesign = merchantProduct();
  const soldOutResult = await updateShopifyProduct(
    soldOutDesign.client,
    updateInput({
      // Out of stock arrives as one design_no placeholder job.
      variants: [job("DE-093", { quantity: 0, details: undefined })],
    }) as never,
  );
  const soldOutCreate = soldOutDesign.calls.find(
    (c) => c.op === "productVariantsBulkCreate",
  );
  check(
    "no design-code variant is invented",
    !soldOutCreate,
    JSON.stringify(soldOutCreate?.variables),
  );
  const soldOutDelete = soldOutDesign.calls.find(
    (c) => c.op === "productVariantsBulkDelete",
  );
  check(
    "sold pieces are deleted but one variant survives",
    ((soldOutDelete?.variables.variantsIds as string[]) ?? []).length === 1,
    JSON.stringify(soldOutDelete?.variables),
  );
  check(
    "the survivor is reported so its quantity goes to zero",
    soldOutResult.variants.length === 1,
    JSON.stringify(soldOutResult.variants),
  );

  console.log("one piece becomes two");

  // A single-piece product sits on Shopify's Title placeholder. A second piece
  // cannot exist there, so the picker is added — nothing the merchant wrote.
  const grew = fakeClient({
    options: [{ name: "Title", values: ["Default Title"] }],
    variants: [
      {
        id: "gid://shopify/ProductVariant/300",
        sku: "DE-093_B2.00",
        price: "1400.00",
        options: [{ name: "Title", value: "Default Title" }],
      },
    ],
  });
  await updateShopifyProduct(
    grew.client,
    updateInput({
      variants: [
        job("DE-093_B2.00"),
        job("DE-093_B3.00", { details: { metal: "Gold", purity: "18K", color: "R" } }),
      ],
      existingVariants: [
        { jobNo: "DE-093_B2.00", externalVariantId: "gid://shopify/ProductVariant/300" },
      ],
    }) as never,
  );
  const grewOps = grew.calls.map((c) => c.op);
  check(
    "a second piece gets the picker it needs",
    grewOps.includes("productOptionsCreate"),
    grewOps.join(", "),
  );
  check(
    "and nothing the merchant wrote is touched",
    !grewOps.includes("productUpdate") && !grewOps.includes("productCreateMedia"),
    grewOps.join(", "),
  );
  const grewCreate = grew.calls.find((c) => c.op === "productVariantsBulkCreate");
  const grewVariants = (grewCreate?.variables.variants ?? []) as Array<{
    optionValues?: Array<{ optionName: string; name: string }>;
  }>;
  check(
    "the second piece lands under a metal label",
    grewVariants[0]?.optionValues?.[0]?.name === "18K Rose Gold",
    JSON.stringify(grewVariants),
  );

  const liveStateQuery = off.calls.find((c) => c.op === "productLiveState")?.query ?? "";
  check(
    "optionValues is read as a list, not a connection",
    liveStateQuery.includes("optionValues {") &&
      !/optionValues\s*\(/.test(liveStateQuery),
    liveStateQuery.slice(0, 200),
  );

  console.log("two pieces, same metal");

  // A design regularly holds several pieces in the same metal, karat and
  // colour. Two variants cannot share an option combination, so the new piece
  // has to be given a label of its own or Shopify rejects the whole batch.
  const sameMetal = fakeClient({
    options: [{ name: "Metal", values: ["14K White Gold"] }],
    variants: [
      {
        id: "gid://shopify/ProductVariant/400",
        sku: "DE-093_B2.00",
        price: "1400.00",
        options: [{ name: "Metal", value: "14K White Gold" }],
      },
    ],
  });
  const twin = { metal: "Gold", purity: "14K", color: "W" };
  await updateShopifyProduct(
    sameMetal.client,
    updateInput({
      variants: [
        job("DE-093_B2.00", { details: twin }),
        job("DE-093_B5.00", { details: twin }),
        job("DE-093_B6.00", { details: { ...twin, size: "6.5" } }),
      ],
      existingVariants: [
        { jobNo: "DE-093_B2.00", externalVariantId: "gid://shopify/ProductVariant/400" },
      ],
    }) as never,
  );
  const twinCreate = sameMetal.calls.find(
    (c) => c.op === "productVariantsBulkCreate",
  );
  const twinValues = (
    (twinCreate?.variables.variants ?? []) as Array<{
      optionValues?: Array<{ name: string }>;
    }>
  ).map((v) => v.optionValues?.[0]?.name);
  check(
    "both new pieces are added",
    twinValues.length === 2,
    JSON.stringify(twinValues),
  );
  check(
    "neither repeats the label already on the product",
    twinValues.every((v) => v !== "14K White Gold"),
    JSON.stringify(twinValues),
  );
  check(
    "and they do not collide with each other",
    new Set(twinValues).size === twinValues.length,
    JSON.stringify(twinValues),
  );
  check(
    "size breaks the tie before the job number does",
    twinValues.includes("14K White Gold · 6.5"),
    JSON.stringify(twinValues),
  );

  console.log("update: content sync on (merchant opted in)");

  const on = merchantProduct();
  await updateShopifyProduct(on.client, updateInput({ syncProductContent: true }) as never);
  check(
    "opting in still rewrites product content",
    on.calls.some((c) => c.op === "productUpdate"),
    on.calls.map((c) => c.op).join(", "),
  );

  console.log("reclaim: an unmapped design that already exists in Shopify");

  const reclaimSeed = fakeClient({
    options: [{ name: "Metal", values: ["14K White Gold", "18K Rose Gold"] }],
    variants: [
      {
        id: "gid://shopify/ProductVariant/100",
        sku: "DE-093_B2.00",
        price: "1400.00",
        options: [{ name: "Metal", value: "14K White Gold" }],
      },
    ],
    findsProductId: "gid://shopify/Product/1",
  });
  await createShopifyProduct(
    reclaimSeed.client,
    {
      connectionId: "11111111-1111-1111-1111-111111111111",
      designNo: "DE-093",
      title: "DE-093",
      imageUrls: ["https://cdn.example.com/de-093.jpg"],
      tags: ["studs"],
      variants: [job("DE-093_B2.00")],
    } as never,
  );
  const reclaimOps = reclaimSeed.calls.map((c) => c.op);
  for (const mutation of [...MERCHANT_OWNED_MUTATIONS, "productCreate"]) {
    check(
      `reclaim never sends ${mutation}`,
      !reclaimOps.includes(mutation),
      reclaimOps.join(", "),
    );
  }

  console.log("options the merchant invented");

  const unfillable = newVariantOptionValues(
    {
      options: [
        { name: "Metal", values: [] },
        { name: "Gift Wrap", values: [] },
      ],
      optionNames: ["Metal", "Gift Wrap"],
      variants: [],
    } as never,
    { jobNo: "J1", details: { metal: "Gold", purity: "14K", color: "W" } },
  );
  check("an option job data cannot fill blocks the add", unfillable === null);

  const fillable = newVariantOptionValues(
    {
      options: [
        { name: "Metal", values: [] },
        { name: "Size", values: [] },
      ],
      optionNames: ["Metal", "Size"],
      variants: [],
    } as never,
    { jobNo: "J1", details: { metal: "Gold", purity: "14K", color: "W", size: "6.5" } },
  );
  check(
    "merchant options that map to job data are filled",
    JSON.stringify(fillable) ===
      JSON.stringify([
        { optionName: "Metal", name: "14K White Gold" },
        { optionName: "Size", name: "6.5" },
      ]),
    JSON.stringify(fillable),
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nmerchant-owned catalog selfcheck passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
