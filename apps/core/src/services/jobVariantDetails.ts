/**
 * Map DevJewels inventory job rows → merchant-visible Shopify variant detail fields.
 * Values include units (gms / cts) where DevJewels UI shows them.
 */

import type { ChannelJobVariantDetails } from "@/channels/types";

export type { ChannelJobVariantDetails };

function clean(raw: unknown): string {
  return String(raw ?? "").trim();
}

/** Append unit when value is non-empty and does not already include it. */
export function withUnit(raw: unknown, unit: string): string {
  const s = clean(raw);
  if (!s) return "";
  const lower = s.toLowerCase();
  const unitLower = unit.toLowerCase();
  if (lower.includes(unitLower)) return s;
  return `${s} ${unit}`;
}

const LAB_GROWN_TOKENS = new Set(["CVD", "HPHT", "LABGROWN"]);

/** Customer stock table: blank diamond quality/color still show these. */
const DEFAULT_DIA_QUALITY = "VVS-VS";
const DEFAULT_DIA_COLOR = "D-E-F";

function positiveAmount(raw: unknown): boolean {
  const n = Number(clean(raw));
  return Number.isFinite(n) && n > 0;
}

/**
 * Same rule as the customer product page Type column:
 * labgrown / natural only when diamond weight is present.
 */
export function stockDiamondTypeLabel(job: Record<string, unknown>): string {
  if (!positiveAmount(job.dwt)) return "";
  const token = clean(job.diamondtype).replace(/\s+/g, "").toUpperCase();
  if (LAB_GROWN_TOKENS.has(token)) return "Lab Grown";
  if (token === "NATURAL") return "Natural";
  return "";
}

/** Customer stock table certificate: space after commas. */
export function formatStockCertificate(raw: unknown): string {
  const s = clean(raw).replace(/[\r\n]+/g, " ");
  if (!s) return "";
  return s
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");
}

/**
 * Build variant details from a channels_api inventory job + design category.
 * Empty strings are omitted so Shopify metafields stay sparse.
 */
export function detailsFromInventoryJob(
  job: Record<string, unknown>,
  category?: string,
  designStoneWt?: unknown,
): ChannelJobVariantDetails {
  const out: ChannelJobVariantDetails = {};
  const store = clean(job.store);
  if (store) out.store = store;
  const cat = clean(category);
  if (cat) out.category = cat;
  const metal = clean(job.metal_type);
  if (metal) out.metal = metal;
  const purity = clean(job.metal_quality);
  if (purity) out.purity = purity;
  const color = clean(job.metal_color);
  if (color) out.color = color;
  out.diaQly = clean(job.diamond_quality) || DEFAULT_DIA_QUALITY;
  out.diaClr = clean(job.diamond_color) || DEFAULT_DIA_COLOR;
  const diamondType = stockDiamondTypeLabel(job);
  if (diamondType) out.diamondType = diamondType;
  const size = clean(job.size);
  if (size) out.size = size;
  const gwt = withUnit(job.gwt, "gms");
  if (gwt) out.gwt = gwt;
  const nwt = withUnit(job.nwt, "gms");
  if (nwt) out.nwt = nwt;
  const dwt = withUnit(job.dwt, "cts");
  if (dwt) out.dwt = dwt;
  const stoneSource = positiveAmount(job.swt) ? job.swt : designStoneWt;
  const swt = positiveAmount(stoneSource) ? withUnit(stoneSource, "cts") : "";
  if (swt) out.swt = swt;
  const certificate = formatStockCertificate(job.certificate);
  if (certificate) out.certificate = certificate;
  return out;
}

/** Assert-based selfcheck — fails if weight units / field mapping regress. */
export function jobVariantDetailsSelfcheck(): void {
  const got = detailsFromInventoryJob(
    {
      store: "NEW YORK",
      metal_type: "GOLD",
      metal_quality: "",
      metal_color: "Y",
      diamond_quality: "VVS-VS",
      diamond_color: "D-E-F",
      size: "7 INCH",
      gwt: "11.680",
      nwt: "10.260",
      dwt: "7.100",
    },
    "Bracelet",
  );
  if (got.store !== "NEW YORK" || got.category !== "Bracelet") {
    throw new Error(`store/category mismatch: ${JSON.stringify(got)}`);
  }
  if (got.metal !== "GOLD" || got.color !== "Y" || got.purity !== undefined) {
    throw new Error(`metal fields mismatch: ${JSON.stringify(got)}`);
  }
  if (got.gwt !== "11.680 gms" || got.nwt !== "10.260 gms" || got.dwt !== "7.100 cts") {
    throw new Error(`weight units mismatch: ${JSON.stringify(got)}`);
  }
  if (got.diaQly !== "VVS-VS" || got.diaClr !== "D-E-F") {
    throw new Error(`diamond defaults mismatch: ${JSON.stringify(got)}`);
  }
  if (withUnit("1.5 gms", "gms") !== "1.5 gms") {
    throw new Error("withUnit should not double-append");
  }
  const typed = detailsFromInventoryJob(
    {
      dwt: "1.200",
      diamondtype: "CVD",
      certificate: "GIA,123",
    },
    undefined,
    "0.450",
  );
  if (typed.diamondType !== "Lab Grown" || typed.certificate !== "GIA, 123") {
    throw new Error(`type/certificate mismatch: ${JSON.stringify(typed)}`);
  }
  if (typed.swt !== "0.450 cts") {
    throw new Error(`stone weight mismatch: ${JSON.stringify(typed)}`);
  }
  if (stockDiamondTypeLabel({ dwt: "0", diamondtype: "NATURAL" }) !== "") {
    throw new Error("type must be omitted when diamond weight is zero");
  }
  const bare = detailsFromInventoryJob({});
  if (bare.diaQly !== "VVS-VS" || bare.diaClr !== "D-E-F" || bare.diamondType) {
    throw new Error(`bare job mismatch: ${JSON.stringify(bare)}`);
  }
}
