/**
 * Assert-based check for Shopify variant metafields + description HTML.
 */
import {
  jobDetailsDescriptionHtml,
  variantMetafields,
} from "./products";

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
  assert(!("purity" in byKey), "empty purity must be omitted");

  const sparse = variantMetafields("DJ-1", "J1", {});
  assert(sparse.length === 2, "sparse details → only job_no + design_no");

  const html = jobDetailsDescriptionHtml("DJ-1", [
    {
      jobNo: "18375",
      price: 100,
      quantity: 1,
      details: {
        store: "NEW YORK",
        metal: "GOLD",
        gwt: "11.680 gms",
      },
    },
  ]);
  assert(html?.includes("Job No: 18375"), "description includes job");
  assert(html?.includes("Store: NEW YORK"), "description includes store");
  assert(html?.includes("Gwt: 11.680 gms"), "description includes gwt");
  assert(!html?.includes("<script"), "description must not allow raw tags from values");
}

shopifyJobDetailsSelfcheck();
console.log("shopify job details selfcheck ok");
