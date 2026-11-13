/**
 * Metal × Size planner + stock table description selfcheck (pure, no Shopify).
 *
 * Run: npm run selfcheck:metal-size-slots -w @devjewels-channels/shopify
 */
import {
  isRingCategory,
  metalSkuCode,
  planMetalSizeSlots,
  ringSizeLabel,
  STANDARD_METALS,
  STANDARD_RING_SIZES,
  type SlotPiece,
} from "./metalSizeSlots";
import { stockTableDescriptionHtml } from "./stockDescription";

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok  ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

function piece(jobNo: string, price: number, color: string, size: string, extra: Partial<SlotPiece["details"]> = {}): SlotPiece {
  return {
    jobNo,
    price,
    wholesaleCost: price / 2,
    details: { metal: "Gold", purity: "14K", color, size, ...extra },
  };
}

function main(): void {
  console.log("ring: every 14K colour and US 3–10 listed");
  const ring = planMetalSizeSlots({
    designNo: "DR-1055_PRS_1.70",
    category: "Ring",
    fallbackPrice: 999,
    pieces: [
      piece("34835", 3300, "W", "7 US"),
      piece("33831", 3100, "W", "7 US"),
      piece("32968", 3100, "W", "7"),
      piece("30282", 3500, "Y", "6.5 US"),
    ],
  });
  check(
    "metals are the three 14K golds, in the merchant's order",
    JSON.stringify(ring.metalValues) === JSON.stringify(STANDARD_METALS),
    ring.metalValues.join(", "),
  );
  check(
    "sizes are 3 to 10 in half sizes",
    JSON.stringify(ring.sizeValues) === JSON.stringify(STANDARD_RING_SIZES) &&
      ring.sizeValues[0] === "3" &&
      ring.sizeValues.at(-1) === "10" &&
      ring.sizeValues.length === 15,
    ring.sizeValues.join(", "),
  );
  check("one variant per combination", ring.slots.length === 3 * 15, String(ring.slots.length));
  const white7 = ring.slots.find((s) => s.metal === "14K White Gold" && s.size === "7");
  check(
    "\"7 US\" and \"7\" land in the same slot",
    white7?.quantity === 3,
    JSON.stringify(white7?.pieces.map((p) => p.jobNo)),
  );
  check(
    "cheapest piece first, job number breaking a price tie",
    JSON.stringify(white7?.pieces.map((p) => p.jobNo)) === JSON.stringify(["32968", "33831", "34835"]),
    JSON.stringify(white7?.pieces.map((p) => p.jobNo)),
  );
  check("an in-stock slot is priced by its cheapest piece", white7?.price === 3100, String(white7?.price));
  const rose6 = ring.slots.find((s) => s.metal === "14K Rose Gold" && s.size === "6");
  check(
    "a combination with no piece is listed sold out",
    rose6?.quantity === 0 && rose6.pieces.length === 0,
    JSON.stringify(rose6),
  );
  check(
    "an empty slot is priced at the design's lowest live price",
    rose6?.price === 3100,
    String(rose6?.price),
  );
  check(
    "SKU names the combination, never a piece",
    white7?.sku === "DR-1055_PRS_1.70-14KW-7" && rose6?.sku === "DR-1055_PRS_1.70-14KR-6",
    `${white7?.sku} / ${rose6?.sku}`,
  );
  const again = planMetalSizeSlots({
    designNo: "DR-1055_PRS_1.70",
    category: "Ring",
    fallbackPrice: 999,
    pieces: [piece("99999", 100, "W", "7")],
  });
  check(
    "SKUs stay the same when the pieces change",
    again.slots.find((s) => s.key === white7?.key)?.sku === white7?.sku,
  );

  console.log("ring: stock outside the standard list");
  const odd = planMetalSizeSlots({
    designNo: "R1",
    category: "Engagement Rings",
    fallbackPrice: 500,
    pieces: [
      piece("1", 800, "Y", "7.25"),
      { jobNo: "2", price: 2000, details: { metal: "Gold", purity: "18K", color: "R", size: "6" } },
      { jobNo: "3", price: 4000, details: { metal: "Platinum", purity: "", color: "W", size: "5" } },
    ],
  });
  check("an off-list size is added", odd.sizeValues.includes("7.25") && odd.sizeValues.length === 16);
  check(
    "sizes stay in numeric order",
    odd.sizeValues.indexOf("7.25") === odd.sizeValues.indexOf("7") + 1,
    odd.sizeValues.join(", "),
  );
  check(
    "a stocked 18K or platinum piece adds its metal while it is in stock",
    odd.metalValues.includes("18K Rose Gold") && odd.metalValues.includes("Platinum") && odd.metalValues.length === 5,
    odd.metalValues.join(", "),
  );
  check("platinum gets its own SKU code", metalSkuCode("Platinum") === "PT" && metalSkuCode("18K Rose Gold") === "18KR");

  console.log("non-ring");
  const chain = planMetalSizeSlots({
    designNo: "DN-063_5.00US",
    category: "Necklace",
    fallbackPrice: 2000,
    pieces: [piece("28809", 2000, "W", "17 Inch"), piece("40938", 2000, "W", "17 INCH"), piece("40942", 1900, "Y", "18 inch")],
  });
  check(
    "only stocked sizes, spelled one way",
    JSON.stringify(chain.sizeValues) === JSON.stringify(["17 Inch", "18 Inch"]),
    chain.sizeValues.join(", "),
  );
  check("three 14K golds × two lengths", chain.slots.length === 6, String(chain.slots.length));
  const earring = planMetalSizeSlots({
    designNo: "DE-092",
    category: "Earring",
    fallbackPrice: 700,
    pieces: [piece("5", 700, "Y", ""), piece("6", 650, "Y", "")],
  });
  check("an earring is not a ring", !isRingCategory("Earring") && isRingCategory("Ring") && isRingCategory("Wedding Bands"));
  check(
    "no sizes anywhere → no Size option, one variant per metal",
    earring.sizeValues.length === 0 && earring.slots.length === 3 && earring.slots.every((s) => s.size === undefined),
    JSON.stringify(earring.slots.map((s) => s.sku)),
  );
  check(
    "yellow holds both pieces, cheapest first",
    JSON.stringify(earring.slots.find((s) => s.metal === "14K Yellow Gold")?.pieces.map((p) => p.jobNo)) === '["6","5"]',
  );

  console.log("sold out and odd data");
  const soldOut = planMetalSizeSlots({ designNo: "R2", category: "Ring", fallbackPrice: 1234, pieces: [] });
  check(
    "a sold-out design still lists every combination, at the design price",
    soldOut.slots.length === 45 && soldOut.slots.every((s) => s.quantity === 0 && s.price === 1234),
  );
  const noMetal = planMetalSizeSlots({
    designNo: "R3",
    category: "Ring",
    fallbackPrice: 1,
    pieces: [{ jobNo: "77", price: 10, details: { size: "7" } }],
  });
  check("a piece with no metal data is reported, not guessed", JSON.stringify(noMetal.unplaced) === '["77"]');
  check("ring sizes ignore words and silly numbers", ringSizeLabel("Size 7.50 US") === "7.5" && ringSizeLabel("NO CHAIN") === "" && ringSizeLabel("45") === "");

  console.log("description: the stock table");
  const html = stockTableDescriptionHtml("DR-1055_PRS_1.70", white7?.pieces ?? []);
  check("headed with the live count", html.startsWith("<h3>In Stock (3) — DR-1055_PRS_1.70</h3>"), html.slice(0, 60));
  check("never prints a price", !/price|\$/i.test(html), html);
  check(
    "rows cheapest first",
    html.indexOf("32968") < html.indexOf("33831") && html.indexOf("33831") < html.indexOf("34835"),
  );
  check("colour as a word", html.includes("<td>White</td>"));
  check("escapes HTML", stockTableDescriptionHtml("<b>", [{ jobNo: "1" }]).includes("&lt;b&gt;"));
  check(
    "no stock says made to order",
    stockTableDescriptionHtml("R2", []).includes("Made to order"),
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nmetal × size slot selfcheck passed");
}

main();
