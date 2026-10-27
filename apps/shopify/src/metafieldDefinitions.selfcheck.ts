/**
 * Metafield definition selfcheck — the piece details must be readable by a theme.
 *
 * Run: npm run selfcheck:metafield-definitions -w @devjewels-channels/shopify
 */
import type { ShopifyAdminClient } from "./client";
import { ensureShopifyVariantMetafieldDefinitions } from "./metafieldDefinitions";
import { variantMetafields } from "./products";
import {
  DEVJEWELS_METAFIELD_NAMESPACE,
  VARIANT_METAFIELD_FIELDS,
} from "./variantMetafieldSchema";

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
    "all under the devjewels namespace",
    written.every((m) => m.namespace === DEVJEWELS_METAFIELD_NAMESPACE),
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
  const freshResult = await ensureShopifyVariantMetafieldDefinitions(fresh.client);
  check(
    "one definition per field",
    freshResult.created.length === VARIANT_METAFIELD_FIELDS.length,
    `${freshResult.created.length}/${VARIANT_METAFIELD_FIELDS.length}`,
  );
  const firstDef = fresh.calls[0]?.variables.definition as Record<string, unknown>;
  check(
    "scoped to the variant, not the product",
    firstDef?.ownerType === "PRODUCTVARIANT",
    String(firstDef?.ownerType),
  );
  check(
    "readable by the storefront — the whole point",
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
  const againResult = await ensureShopifyVariantMetafieldDefinitions(again.client);
  check(
    "an existing definition is not an error",
    againResult.existing.length === VARIANT_METAFIELD_FIELDS.length &&
      Object.keys(againResult.failed).length === 0,
    JSON.stringify(againResult.failed),
  );
  check(
    "storefront access is re-asserted in case it was off",
    again.calls.some(
      (c) =>
        c.op === "metafieldDefinitionUpdate" &&
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
  const deniedResult = await ensureShopifyVariantMetafieldDefinitions(denied.client);
  check(
    "a missing scope is reported, not thrown",
    Object.keys(deniedResult.failed).length === VARIANT_METAFIELD_FIELDS.length &&
      deniedResult.created.length === 0,
  );

  const exploded = fakeClient(() => {
    throw new Error("network down");
  });
  const explodedResult = await ensureShopifyVariantMetafieldDefinitions(
    exploded.client,
  );
  check(
    "a network failure is reported, not thrown",
    Object.keys(explodedResult.failed).length === VARIANT_METAFIELD_FIELDS.length,
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
