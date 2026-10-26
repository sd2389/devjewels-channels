/**
 * Assert-based check for Shopify variant metafields + description HTML.
 */
import {
  jobDetailsDescriptionHtml,
  storefrontMetalLabel,
  storefrontOptionPlan,
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
  assert(
    html?.includes("<h3>In Stock (1) — DJ-1&lt;script&gt;</h3>"),
    "design heading is escaped",
  );
  assert(html?.includes("<table"), "description is the stock table");
  assert(html?.includes("<th>Job No</th>"), "each in-stock piece is a job number row");
  assert(html?.includes("<td>18375</td>"), "job number is the piece cell");
  assert(html?.includes("<td>Gold</td>"), "metal is title case, same words as the picker");
  assert(!html?.includes(">GOLD<"), "raw API metal token is not written through");
  assert(html?.includes("<th>Store</th>"), "store column when a job has a store");
  assert(html?.includes("<td>NEW YORK</td>"), "store cell");
  assert(html?.includes("<th>Gold WT</th>"), "gold weight column");
  assert(html?.includes("<td>11.680 gms</td>"), "gold weight keeps its unit");
  assert(html?.includes("<th>Quality</th>"), "quality column matches the customer table");
  assert(html?.includes("<td>—</td>"), "blank quality cell is a dash");
  assert(!html?.includes("<th>Type</th>"), "type column hidden when no job has a type");
  assert(!html?.includes("<th>Purity</th>"), "quality label is not Purity");
  assert(!html?.includes(" · "), "description must not use inline separators");
  assert(!html?.includes("<script"), "description must not allow raw tags from values");
  const rich = jobDetailsDescriptionHtml("DJ-2", [
    {
      jobNo: "18376",
      price: 1650,
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
  assert(rich?.includes("<th>Type</th>"), "type column");
  assert(rich?.includes("<td>Lab Grown</td>"), "type cell");
  assert(rich?.includes("<th>Stone WT</th>"), "stone weight column");
  assert(rich?.includes("<td>0.450 cts</td>"), "stone weight cell");
  assert(rich?.includes("<th>Certificate</th>"), "certificate column");
  assert(rich?.includes("<td>GIA, 123</td>"), "certificate cell");
  assert(rich?.includes("<td>$1,650.00</td>"), "price matches the customer table");

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
