/**
 * Metal × Size writer selfcheck — productSet shape against a fake Shopify.
 *
 * Run: npm run selfcheck:metal-size-variants -w @devjewels-channels/shopify
 */
import type { ShopifyAdminClient } from "./client";
import { planMetalSizeSlots } from "./metalSizeSlots";
import { syncShopifyMetalSizeVariants } from "./metalSizeVariants";

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok  ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

type Call = { op: string; vars: Record<string, unknown> };
type Variant = { id?: string; sku?: string; price?: string };

/** Fake Shopify: echoes productSet variants back with ids, like the real one. */
function fakeShopify(liveProduct: null | { options: string[]; variants: Variant[] }) {
  const calls: Call[] = [];
  let next = 1000;
  const client: ShopifyAdminClient = {
    shopDomain: "merchant.myshopify.com",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    graphql: (async (query: string, variables?: Record<string, unknown>) => {
      const op = /(mutation|query)\s+(\w+)/.exec(query)?.[2] ?? "unknown";
      const vars = variables ?? {};
      calls.push({ op, vars });
      if (op === "productsFindByDesign") return { data: { products: { nodes: [] } } };
      if (op === "productLiveState") {
        return {
          data: {
            product: {
              id: "gid://shopify/Product/1",
              options: (liveProduct?.options ?? []).map((name, i) => ({ id: `o${i}`, name, optionValues: [] })),
              variants: {
                nodes: (liveProduct?.variants ?? []).map((v) => ({
                  id: v.id,
                  sku: v.sku,
                  price: v.price,
                  selectedOptions: [],
                  inventoryItem: { id: `${v.id}-item` },
                })),
              },
            },
          },
        };
      }
      if (op === "productSet") {
        const input = vars.input as { id?: string; variants: Variant[] };
        return {
          data: {
            productSet: {
              product: {
                id: input.id ?? "gid://shopify/Product/NEW",
                variants: {
                  nodes: input.variants.map((v) => {
                    const id = v.id ?? `gid://shopify/ProductVariant/${(next += 1)}`;
                    return { id, sku: v.sku, inventoryItem: { id: `${id}-item` } };
                  }),
                },
              },
              userErrors: [],
            },
          },
        };
      }
      return { data: { [op]: { userErrors: [] } } };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  };
  return { client, calls };
}

const pieces = [
  { jobNo: "34835", price: 3300, wholesaleCost: 1500, details: { metal: "Gold", purity: "14K", color: "W", size: "7 US" } },
  { jobNo: "33831", price: 3100, wholesaleCost: 1400, details: { metal: "Gold", purity: "14K", color: "W", size: "7 US" } },
];

function baseInput(plan: ReturnType<typeof planMetalSizeSlots>, extra: Record<string, unknown> = {}) {
  return {
    connectionId: "c1",
    designNo: "DR-1055",
    title: "DR-1055",
    plan,
    includeCost: true,
    writeInventory: true,
    syncProductDescription: true,
    locationId: "gid://shopify/Location/9",
    imageUrls: ["https://cdn.example/a.jpg"],
    ...extra,
  };
}

async function main(): Promise<void> {
  console.log("existing per-piece product becomes Metal × Size");
  const plan = planMetalSizeSlots({ designNo: "DR-1055", category: "Ring", fallbackPrice: 3000, pieces });
  const existing = fakeShopify({
    options: ["Metal Type", "Karat", "Diamond Band"],
    variants: [
      { id: "gid://shopify/ProductVariant/1", sku: "34835", price: "3300.00" },
      // Already a slot from an earlier sync, with a price the merchant edited.
      { id: "gid://shopify/ProductVariant/2", sku: "DR-1055-14KW-7", price: "4100.00" },
    ],
  });
  const result = await syncShopifyMetalSizeVariants(
    existing.client,
    baseInput(plan, { externalProductId: "gid://shopify/Product/1" }),
  );
  const set = existing.calls.find((c) => c.op === "productSet");
  const setInput = set?.vars.input as {
    id?: string;
    title?: string;
    metafields?: unknown;
    productOptions: Array<{ name: string; values: Array<{ name: string }> }>;
    variants: Array<{
      id?: string;
      sku: string;
      price: string;
      inventoryPolicy: string;
      inventoryItem: { tracked: boolean; cost?: string };
      metafields: Array<{ key: string; value: string }>;
      optionValues: Array<{ optionName: string; name: string }>;
    }>;
  };
  check("one productSet for the whole product", existing.calls.filter((c) => c.op === "productSet").length === 1);
  check("updates the mapped product by id", setInput?.id === "gid://shopify/Product/1");
  check(
    "options are exactly Metal then Size",
    JSON.stringify(setInput?.productOptions.map((o) => o.name)) === '["Metal","Size"]' &&
      setInput.productOptions[1]!.values.length === 15,
  );
  check(
    "never sends product content or product metafields on an existing product",
    setInput?.title === undefined && setInput?.metafields === undefined && !("descriptionHtml" in (setInput ?? {})),
  );
  check("one variant per slot", setInput?.variants.length === 45, String(setInput?.variants.length));
  const w7 = setInput?.variants.find((v) => v.sku === "DR-1055-14KW-7");
  check("an existing slot variant keeps its id", w7?.id === "gid://shopify/ProductVariant/2");
  check("…and the merchant's price", w7?.price === "4100.00", w7?.price);
  check(
    "it is backed by the cheapest piece",
    w7?.metafields.find((m) => m.key === "job_no")?.value === "33831",
  );
  check("cost comes from the backing piece", w7?.inventoryItem.cost === "1400.00", w7?.inventoryItem.cost);
  const r6 = setInput?.variants.find((v) => v.sku === "DR-1055-14KR-6");
  check("a new slot gets the slot price", r6?.price === "3100.00" && r6.id === undefined, r6?.price);
  check(
    "every variant is DENY and tracked",
    setInput?.variants.every((v) => v.inventoryPolicy === "DENY" && v.inventoryItem.tracked === true) ?? false,
  );
  check(
    "an empty slot carries no job number",
    !r6?.metafields.some((m) => m.key === "job_no") && r6?.metafields.some((m) => m.key === "size" && m.value === "6"),
    JSON.stringify(r6?.metafields),
  );
  check(
    "the old per-piece variant is left out, so productSet removes it",
    !setInput?.variants.some((v) => v.id === "gid://shopify/ProductVariant/1"),
  );
  const qty = existing.calls.find((c) => c.op === "inventorySetQuantities")?.vars.input as {
    quantities: Array<{ inventoryItemId: string; quantity: number; locationId: string }>;
  };
  check("quantities set for every slot in one call", qty?.quantities.length === 45);
  check(
    "a slot's quantity is its piece count",
    qty?.quantities.find((q) => q.inventoryItemId === "gid://shopify/ProductVariant/2-item")?.quantity === 2,
  );
  check(
    "empty slots are zero",
    qty?.quantities.filter((q) => q.quantity === 0).length === 44,
  );
  const desc = existing.calls.find((c) => c.op === "productUpdate")?.vars.product as Record<string, unknown>;
  check(
    "the description write sends only id and descriptionHtml",
    JSON.stringify(Object.keys(desc ?? {}).sort()) === '["descriptionHtml","id"]',
    JSON.stringify(Object.keys(desc ?? {})),
  );
  check("the description is the stock table", String(desc?.descriptionHtml).startsWith("<h3>In Stock (2)"));
  check(
    "the product summary metafields are still written",
    existing.calls.some((c) => c.op === "metafieldsSet"),
  );
  check("images are not touched on an existing product", !existing.calls.some((c) => c.op === "productCreateMedia"));
  check(
    "result maps every slot to its variant and pieces",
    result.slots.length === 45 &&
      JSON.stringify(result.slots.find((s) => s.sku === "DR-1055-14KW-7")?.jobNos) === '["33831","34835"]',
  );

  console.log("new product");
  const fresh = fakeShopify(null);
  let mapped = "";
  await syncShopifyMetalSizeVariants(
    fresh.client,
    baseInput(plan, {
      syncProductDescription: false,
      writeInventory: false,
      onExternalProductId: async (id: string) => {
        mapped = id;
      },
    }),
  );
  const created = fresh.calls.find((c) => c.op === "productSet")?.vars.input as Record<string, unknown>;
  check(
    "creates as a draft with our vendor and title",
    created?.id === undefined && created.status === "DRAFT" && created.vendor === "Dev Jewels Inc." && created.title === "DR-1055",
  );
  check("maps the new product id straight away", mapped === "gid://shopify/Product/NEW");
  check("no description write when not opted in", !fresh.calls.some((c) => c.op === "productUpdate"));
  check("no quantity write when inventory sync is off", !fresh.calls.some((c) => c.op === "inventorySetQuantities"));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nmetal × size writer selfcheck passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
