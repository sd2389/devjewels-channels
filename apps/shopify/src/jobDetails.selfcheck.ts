/**
 * Assert-based check for Shopify variant metafields (structured stock data).
 * Piece attributes must never depend on product description HTML.
 * Unit price/cost must never be written as a metafield (Liquid-readable).
 */
import {
  storefrontMetalLabel,
  storefrontOptionPlan,
  variantMetafields,
} from "./products";
import { VARIANT_METAFIELD_FIELDS } from "./variantMetafieldSchema";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function shopifyJobDetailsSelfcheck(): void {
  const fields = variantMetafields("DJ-1", "18375", {
    store: "NEW YORK",
    category: "Bracelet",
    metal: "GOLD",
    color: "Y",
    diaQly: "VVS-VS",
    diaClr: "D-E-F",
    size: "7 INCH",
    gwt: "11.680 gms",
    nwt: "10.260 gms",
    dwt: "7.100 cts",
  });
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f.value]));
  assert(byKey.job_no === "18375", "job_no metafield");
  assert(byKey.design_no === "DJ-1", "design_no metafield");
  assert(byKey.store === "NEW YORK", "store metafield");
  assert(byKey.category === "Bracelet", "category metafield");
  assert(byKey.metal === "GOLD", "metal metafield");
  assert(byKey.dia_qly === "VVS-VS", "dia_qly metafield");
  assert(byKey.gwt === "11.680 gms", "gwt metafield with unit");
  assert(byKey.dwt === "7.100 cts", "dwt metafield with unit");
  assert(!("price" in byKey), "unit price must never be a Liquid-readable metafield");
  assert(
    !VARIANT_METAFIELD_FIELDS.some((f) => f.key === "price"),
    "schema must not declare a price metafield",
  );
  assert(
    VARIANT_METAFIELD_FIELDS.every((f) => f.storefrontAccess === "PUBLIC_READ"),
    "stock attribute metafields are storefront-readable",
  );
  assert(!("purity" in byKey), "empty purity must be omitted");

  const sparse = variantMetafields("DJ-1", "J1", {});
  assert(sparse.length === 2, "sparse details → only job_no + design_no");

  const rich = variantMetafields("DJ-2", "18376", {
    diamondType: "Lab Grown",
    diaQly: "VVS-VS",
    diaClr: "D-E-F",
    dwt: "1.200 cts",
    swt: "0.450 cts",
    certificate: "GIA, 123",
  });
  const richByKey = Object.fromEntries(rich.map((f) => [f.key, f.value]));
  assert(richByKey.diamond_type === "Lab Grown", "diamond_type metafield");
  assert(richByKey.swt === "0.450 cts", "swt metafield");
  assert(richByKey.certificate === "GIA, 123", "certificate metafield");
  assert(!("price" in richByKey), "rich details must still omit price");

  assert(
    storefrontMetalLabel({ metal: "GOLD", purity: "14K", color: "W" }) === "14K White Gold",
    "14K white gold label",
  );
  assert(
    storefrontMetalLabel({ metal: "Rose Gold", purity: "18K", color: "Rose" }) === "18K Rose Gold",
    "rose gold label does not repeat the color",
  );
  assert(storefrontMetalLabel({ metal: "Platinum" }) === "Platinum", "platinum label");
  assert(storefrontMetalLabel({}) === "", "empty metal has no label");

  const plan = storefrontOptionPlan([
    { jobNo: "31147", details: { metal: "Gold", purity: "14K", color: "White" } },
    { jobNo: "31148", details: { metal: "Gold", purity: "18K", color: "Rose" } },
  ]);
  assert(plan?.optionName === "Metal", "picker is named Metal");
  assert(plan?.byJob.get("31147") === "14K White Gold", "14K white value");
  assert(plan?.byJob.get("31148") === "18K Rose Gold", "18K rose value");

  const sized = storefrontOptionPlan([
    { jobNo: "1", details: { metal: "Gold", purity: "14K", color: "White", size: "7" } },
    { jobNo: "2", details: { metal: "Gold", purity: "14K", color: "White", size: "8" } },
  ]);
  assert(sized?.byJob.get("1") === "14K White Gold · 7", "same metal uses size");
  assert(sized?.byJob.get("2") === "14K White Gold · 8", "second size stays unique");

  const clash = storefrontOptionPlan([
    { jobNo: "1", details: { metal: "Gold", purity: "14K", color: "White" } },
    { jobNo: "2", details: { metal: "Gold", purity: "14K", color: "White" } },
  ]);
  assert(clash?.byJob.get("1") === "14K White Gold · 1", "identical pieces keep the job number");
  assert(clash?.byJob.get("2") === "14K White Gold · 2", "second identical piece stays unique");

  assert(
    storefrontOptionPlan([
      { jobNo: "31147", details: { metal: "Gold", purity: "14K", color: "White" } },
    ]) === null,
    "one piece hides the picker",
  );
  const noMetal = storefrontOptionPlan([
    { jobNo: "A", details: {} },
    { jobNo: "B", details: {} },
  ]);
  assert(noMetal?.optionName === "Job", "no metal data keeps the job option");
  assert(noMetal?.byJob.get("A") === "A", "job number remains the value when metal is unknown");
}

shopifyJobDetailsSelfcheck();
console.log("shopify job details selfcheck ok");
