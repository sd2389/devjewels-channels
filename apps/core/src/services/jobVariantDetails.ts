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

/**
 * Build variant details from a channels_api inventory job + design category.
 * Empty strings are omitted so Shopify metafields stay sparse.
 */
export function detailsFromInventoryJob(
  job: Record<string, unknown>,
  category?: string,
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
  const diaQly = clean(job.diamond_quality);
  if (diaQly) out.diaQly = diaQly;
  const diaClr = clean(job.diamond_color);
  if (diaClr) out.diaClr = diaClr;
  const size = clean(job.size);
  if (size) out.size = size;
  const gwt = withUnit(job.gwt, "gms");
  if (gwt) out.gwt = gwt;
  const nwt = withUnit(job.nwt, "gms");
  if (nwt) out.nwt = nwt;
  const dwt = withUnit(job.dwt, "cts");
  if (dwt) out.dwt = dwt;
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
  if (withUnit("1.5 gms", "gms") !== "1.5 gms") {
    throw new Error("withUnit should not double-append");
  }
  if (Object.keys(detailsFromInventoryJob({})).length !== 0) {
    throw new Error("empty job should yield empty details");
  }
}
