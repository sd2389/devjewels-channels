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

  const html = jobDetailsDescriptionHtml("DJ-1<script>", [
    {
      jobNo: "18375",
      price: 100,
      quantity: 1,
      details: {
        store: "NEW YORK",
        metal: "GOLD",
        purity: " ",
        gwt: "11.680 gms",
      },
    },
  ]);
  assert(html?.includes("<h3>Design No: DJ-1&lt;script&gt;</h3>"), "design heading");
  assert(
    html?.includes("<strong>Job No:</strong> 18375"),
    "job is a labelled field",
  );
  assert(
    html?.includes("<strong>Store:</strong> NEW YORK"),
    "store is a labelled field",
  );
  assert(
    html?.includes("<strong>Gold WT:</strong> 11.680 gms"),
    "gold weight keeps unit and customer-page label",
  );
  assert(!html?.includes("<strong>Purity:</strong>"), "quality label is not Purity");
  assert(
    html?.includes("<strong>Job No:</strong> 18375<br>"),
    "fields are separated by line breaks",
  );
  assert(!html?.includes("<table"), "description must not use tables (theme-unsafe)");
  assert(!html?.includes(" · "), "description must not use inline separators");
  assert(!html?.includes("<strong>Quality:</strong>"), "empty fields must be omitted");
  const rich = jobDetailsDescriptionHtml("DJ-2", [
    {
      jobNo: "18376",
      price: 100,
      quantity: 1,
      details: {
        diamondType: "Lab Grown",
        diaQly: "VVS-VS",
        diaClr: "D-E-F",
        dwt: "1.200 cts",
        swt: "0.450 cts",
        certificate: "GIA, 123",
      },
    },
  ]);
  assert(rich?.includes("<strong>Type:</strong> Lab Grown"), "type label");
  assert(rich?.includes("<strong>Stone WT:</strong> 0.450 cts"), "stone weight");
  assert(rich?.includes("<strong>Certificate:</strong> GIA, 123"), "certificate");
  assert(rich?.includes("<strong>Dia Quality:</strong> VVS-VS"), "dia quality label");
  assert(!html?.includes("<script"), "description must not allow raw tags from values");
}

shopifyJobDetailsSelfcheck();
console.log("shopify job details selfcheck ok");
