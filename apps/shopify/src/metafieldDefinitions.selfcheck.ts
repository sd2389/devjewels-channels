/**
 * Metafield definition selfcheck — the piece details must be readable by a theme.
 *
 * Run: npm run selfcheck:metafield-definitions -w @devjewels-channels/shopify
 */
import type { ShopifyAdminClient } from "./client";
import { ensureShopifyMetafieldDefinitions } from "./metafieldDefinitions";
import { variantMetafields } from "./products";
import {
  buildProductMetafields,
  DEVJEWELS_METAFIELD_NAMESPACE,
  PRODUCT_METAFIELD_FIELDS,
  VARIANT_METAFIELD_FIELDS,
} from "./variantMetafieldSchema";

/** Variant fields plus the product summary — one definition each. */
const ALL_DEFINITIONS = VARIANT_METAFIELD_FIELDS.length + PRODUCT_METAFIELD_FIELDS.length;

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok  ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

type Recorded = { op: string; variables: Record<string, unknown> };

function fakeClient(reply: (op: string, vars: Record<string, unknown>) => unknown): {
  client: ShopifyAdminClient;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const client: ShopifyAdminClient = {
    shopDomain: "merchant.myshopify.com",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    graphql: (async (query: string, variables?: Record<string, unknown>) => {
      const op =
        /mutation\s+(\w+)/.exec(query)?.[1] ?? /query\s+(\w+)/.exec(query)?.[1] ?? "unknown";
      calls.push({ op, variables: variables ?? {} });
      return reply(op, variables ?? {});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  };
  return { client, calls };
}

async function main(): Promise<void> {
  console.log("schema: definitions and values stay in step");

  const written = variantMetafields("DE-093", "37471", {
    metal: "Gold",
    purity: "14K",
    color: "Y",
    diamondType: "Lab Grown",
    diaQly: "VVS2",
    diaClr: "FANCY INTENCE YELLOW",
    gwt: "2.37",
    dwt: "3.09",
    size: "NO CHAIN",
    store: "JIS",
    certificate: "LG804670094",
  });
  const defined = new Set(VARIANT_METAFIELD_FIELDS.map((f) => f.key));
  check(
    "every value written has a definition behind it",
    written.every((m) => defined.has(m.key)),
    written.map((m) => m.key).join(", "),
  );
  check(
    "every column of the stock table is covered",
    [
      "job_no",
      "metal",
      "purity",
      "color",
      "diamond_type",
      "dia_qly",
      "dia_clr",
      "gwt",
      "dwt",
      "size",
      "store",
      "certificate",
    ].every((k) => written.some((m) => m.key === k)),
    written.map((m) => m.key).join(", "),
  );
  check(
    "unit price is never written as a metafield (Liquid would expose it)",
    !written.some((m) => m.key === "price") &&
      !VARIANT_METAFIELD_FIELDS.some((f) => f.key === "price"),
  );
  check(
    "all under the devjewels namespace",
    written.every((m) => m.namespace === DEVJEWELS_METAFIELD_NAMESPACE),
  );
  check(
    "colour is written as a word a shopper can read",
    written.find((m) => m.key === "color")?.value === "Yellow",
    written.find((m) => m.key === "color")?.value,
  );
  const colours = ["W", "y", "R", "TT"].map(
    (code) =>
      variantMetafields("D", "J", { color: code }).find((m) => m.key === "color")
        ?.value,
  );
  check(
    "every known code maps, and an unknown one passes through untouched",
    JSON.stringify(colours) === JSON.stringify(["White", "Yellow", "Rose", "TT"]),
    JSON.stringify(colours),
  );

  console.log("product: the design's details table");

  const summary = buildProductMetafields({
    designNo: "DBG-136",
    pieces: [
      {
        store: "JIS",
        category: "Bracelet",
        metal: "Gold",
        purity: "14K",
        color: "Y",
        diaQly: "VVS-VS",
        diaClr: "D-E-F",
        gwt: "14.13 gms",
        nwt: "13.102 gms",
        dwt: "1.79 cts",
        certificate: "LG1",
      },
      {
        store: "NEW YORK",
        category: "Bracelet",
        metal: "Gold",
        purity: "14K",
        color: "W",
        diaQly: "VVS-VS",
        diaClr: "D-E-F",
        gwt: "14.61 gms",
        nwt: "13.586 gms",
        dwt: "1.79 cts",
        certificate: "LG2",
      },
    ],
  });
  const valueOf = (key: string) => summary.set.find((m) => m.key === key)?.value;
  check(
    "job no, store and certificate stay on the piece, never the product",
    !["job_no", "store", "certificate"].some(
      (k) => valueOf(k) !== undefined || PRODUCT_METAFIELD_FIELDS.some((f) => f.key === k),
    ),
    summary.set.map((m) => m.key).join(", "),
  );
  check("design no is on the product", valueOf("design_no") === "DBG-136", valueOf("design_no"));
  check(
    "shared values are written once",
    valueOf("category") === "Bracelet" && valueOf("dia_qly") === "VVS-VS",
    `${valueOf("category")} / ${valueOf("dia_qly")}`,
  );
  check(
    "different colours are listed as words",
    valueOf("color") === "White, Yellow",
    valueOf("color"),
  );
  check(
    "different weights become a range with one unit",
    valueOf("gwt") === "14.13 – 14.61 gms" && valueOf("nwt") === "13.102 – 13.586 gms",
    `${valueOf("gwt")} / ${valueOf("nwt")}`,
  );
  check("equal weights stay one value", valueOf("dwt") === "1.79 cts", valueOf("dwt"));
  check(
    "a field no piece carries is cleared, not left stale",
    summary.clear.includes("swt") && summary.clear.includes("size"),
    summary.clear.join(", "),
  );
  check(
    "unit price is never written on the product",
    !PRODUCT_METAFIELD_FIELDS.some((f) => f.key === "price"),
  );
  const soldOut = buildProductMetafields({ designNo: "DBG-136", pieces: [] });
  check(
    "a sold-out design keeps its last details (made to order)",
    soldOut.clear.length === 0 &&
      soldOut.set.map((m) => m.key).join() === "design_no",
    JSON.stringify(soldOut),
  );

  console.log("create: a fresh shop");

  const fresh = fakeClient(() => ({
    data: {
      metafieldDefinitionCreate: {
        createdDefinition: { id: "gid://shopify/MetafieldDefinition/1" },
        userErrors: [],
      },
    },
  }));
  const freshResult = await ensureShopifyMetafieldDefinitions(fresh.client);
  check(
    "one definition per field",
    freshResult.created.length === ALL_DEFINITIONS,
    `${freshResult.created.length}/${ALL_DEFINITIONS}`,
  );
  const productDefs = fresh.calls
    .map((c) => c.variables.definition as Record<string, unknown>)
    .filter((d) => d?.ownerType === "PRODUCT");
  check(
    "the product summary is declared on the product, so the admin card shows it",
    productDefs.length === PRODUCT_METAFIELD_FIELDS.length &&
      productDefs.every(
        (d) => JSON.stringify(d.access) === JSON.stringify({ storefront: "PUBLIC_READ" }),
      ),
    productDefs.map((d) => d.key).join(", "),
  );
  check(
    "variant and product keys are reported apart",
    freshResult.created.includes("metal") && freshResult.created.includes("product.metal"),
    freshResult.created.join(", "),
  );
  const firstDef = fresh.calls[0]?.variables.definition as Record<string, unknown>;
  check(
    "scoped to the variant, not the product",
    firstDef?.ownerType === "PRODUCTVARIANT",
    String(firstDef?.ownerType),
  );
  check(
    "stock attributes are readable by the storefront",
    JSON.stringify(firstDef?.access) === JSON.stringify({ storefront: "PUBLIC_READ" }),
    JSON.stringify(firstDef?.access),
  );
  check(
    "no admin access on a merchant-owned namespace, which Shopify rejects",
    !("admin" in ((firstDef?.access ?? {}) as Record<string, unknown>)),
    JSON.stringify(firstDef?.access),
  );
  check(
    "labelled with the stock table column name",
    firstDef?.name === "Job No",
    String(firstDef?.name),
  );
  check(
    "no price metafield definition is created",
    !fresh.calls.some(
      (c) =>
        c.op === "metafieldDefinitionCreate" &&
        (c.variables.definition as { key?: string })?.key === "price",
    ),
  );

  console.log("re-run: a shop that already has them");

  const again = fakeClient((op) =>
    op === "metafieldDefinitionCreate"
      ? {
          data: {
            metafieldDefinitionCreate: {
              userErrors: [{ code: "TAKEN", message: "Key is in use" }],
            },
          },
        }
      : {
          data: {
            metafieldDefinitionUpdate: {
              updatedDefinition: { id: "gid://shopify/MetafieldDefinition/1" },
              userErrors: [],
            },
          },
        },
  );
  const againResult = await ensureShopifyMetafieldDefinitions(again.client);
  check(
    "an existing definition is not an error",
    againResult.existing.length === ALL_DEFINITIONS &&
      Object.keys(againResult.failed).length === 0,
    JSON.stringify(againResult.failed),
  );
  check(
    "storefront access is re-asserted in case it was off",
    again.calls.some(
      (c) =>
        c.op === "metafieldDefinitionUpdate" &&
        (c.variables.definition as { key?: string })?.key === "job_no" &&
        JSON.stringify(
          (c.variables.definition as Record<string, unknown>)?.access,
        ) === JSON.stringify({ storefront: "PUBLIC_READ" }),
    ),
  );
  console.log("failure: must never break a connect");

  const denied = fakeClient(() => ({
    data: {
      metafieldDefinitionCreate: {
        userErrors: [
          { code: "ACCESS_DENIED", message: "write_metafield_definitions required" },
        ],
      },
    },
  }));
  const deniedResult = await ensureShopifyMetafieldDefinitions(denied.client);
  check(
    "a missing scope is reported, not thrown",
    Object.keys(deniedResult.failed).length === ALL_DEFINITIONS &&
      deniedResult.created.length === 0,
  );

  const exploded = fakeClient(() => {
    throw new Error("network down");
  });
  const explodedResult = await ensureShopifyMetafieldDefinitions(
    exploded.client,
  );
  check(
    "a network failure is reported, not thrown",
    Object.keys(explodedResult.failed).length === ALL_DEFINITIONS,
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nmetafield definition selfcheck passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
