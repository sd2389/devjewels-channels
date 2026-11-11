/**
 * The piece details DevJewels publishes on every Shopify variant, and the
 * design-level summary of them it publishes on the product.
 *
 * One list per owner, two readers each: `buildVariantMetafields` /
 * `buildProductMetafields` write the values, and
 * `ensureShopifyMetafieldDefinitions` declares them to Shopify so a theme can
 * read them. Keeping both off this list stops the two from drifting apart —
 * a value with no definition is invisible on the storefront, and a definition
 * with no value is an empty field in the merchant's admin.
 *
 * Labels match the DevJewels customer stock table column for column.
 *
 * Never write DevJewels unit price/cost as a metafield: Shopify Liquid can still
 * read values even when definition storefront access is NONE. Wholesale cost
 * stays on `inventoryItem.cost` (Admin); selling price is the Shopify variant
 * price (merchant-owned unless content sync is on).
 */
import type { ChannelJobVariantDetails } from "@devjewels-channels/core/channels/types";

export const DEVJEWELS_METAFIELD_NAMESPACE = "devjewels";

/** Shopify owner type for a variant-scoped metafield definition. */
export const VARIANT_METAFIELD_OWNER_TYPE = "PRODUCTVARIANT";

/** Shopify owner type for a product-scoped metafield definition. */
export const PRODUCT_METAFIELD_OWNER_TYPE = "PRODUCT";

export const VARIANT_METAFIELD_TYPE = "single_line_text_field";

/** Shopify Storefront API / Liquid visibility for a definition. */
export type VariantMetafieldStorefrontAccess = "PUBLIC_READ" | "NONE";

/** Shopify caps a single_line_text_field at 255 characters. */
const VALUE_MAX = 255;

/**
 * Metal colour codes as the backend stores them. The storefront picker and the
 * Color metafield both read this map, so a shopper never sees "Y" in one place
 * and "Yellow" in the other.
 */
export const METAL_COLOR_WORDS: Record<string, string> = {
  w: "White",
  y: "Yellow",
  r: "Rose",
};

/** "Y" → "Yellow". A code outside the map passes through unchanged. */
export function metalColorWord(raw: string | undefined): string {
  const code = String(raw || "").trim();
  return METAL_COLOR_WORDS[code.toLowerCase()] ?? code;
}

export type VariantMetafieldContext = {
  designNo: string;
  jobNo: string;
  details?: ChannelJobVariantDetails;
};

export type VariantMetafieldField = {
  key: string;
  /** Merchant-facing label in Shopify admin — the stock table column name. */
  name: string;
  /**
   * PUBLIC_READ = theme/Liquid may show it.
   * NONE = Admin API / merchant backend only (never the public website).
   */
  storefrontAccess: VariantMetafieldStorefrontAccess;
  read: (ctx: VariantMetafieldContext) => string | undefined;
};

export const VARIANT_METAFIELD_FIELDS: VariantMetafieldField[] = [
  { key: "job_no", name: "Job No", storefrontAccess: "PUBLIC_READ", read: (c) => c.jobNo },
  {
    key: "design_no",
    name: "Design No",
    storefrontAccess: "PUBLIC_READ",
    read: (c) => c.designNo,
  },
  {
    key: "metal",
    name: "Metal",
    storefrontAccess: "PUBLIC_READ",
    read: (c) => c.details?.metal,
  },
  {
    key: "purity",
    name: "Quality",
    storefrontAccess: "PUBLIC_READ",
    read: (c) => c.details?.purity,
  },
  {
    key: "color",
    name: "Color",
    storefrontAccess: "PUBLIC_READ",
    read: (c) => metalColorWord(c.details?.color),
  },
  {
    key: "diamond_type",
    name: "Type",
    storefrontAccess: "PUBLIC_READ",
    read: (c) => c.details?.diamondType,
  },
  {
    key: "dia_qly",
    name: "Dia Quality",
    storefrontAccess: "PUBLIC_READ",
    read: (c) => c.details?.diaQly,
  },
  {
    key: "dia_clr",
    name: "Dia Color",
    storefrontAccess: "PUBLIC_READ",
    read: (c) => c.details?.diaClr,
  },
  { key: "gwt", name: "Gold WT", storefrontAccess: "PUBLIC_READ", read: (c) => c.details?.gwt },
  { key: "nwt", name: "Net WT", storefrontAccess: "PUBLIC_READ", read: (c) => c.details?.nwt },
  {
    key: "dwt",
    name: "Diamond WT",
    storefrontAccess: "PUBLIC_READ",
    read: (c) => c.details?.dwt,
  },
  {
    key: "swt",
    name: "Stone WT",
    storefrontAccess: "PUBLIC_READ",
    read: (c) => c.details?.swt,
  },
  { key: "size", name: "Size", storefrontAccess: "PUBLIC_READ", read: (c) => c.details?.size },
  {
    key: "store",
    name: "Store",
    storefrontAccess: "PUBLIC_READ",
    read: (c) => c.details?.store,
  },
  {
    key: "category",
    name: "Category",
    storefrontAccess: "PUBLIC_READ",
    read: (c) => c.details?.category,
  },
  {
    key: "certificate",
    name: "Certificate",
    storefrontAccess: "PUBLIC_READ",
    read: (c) => c.details?.certificate,
  },
];

export type ShopifyMetafieldInput = {
  namespace: string;
  key: string;
  type: string;
  value: string;
};

/**
 * Variant metafields for one piece.
 *
 * A detail the job does not carry is left out rather than written blank:
 * Shopify rejects an empty single_line_text_field, and an omitted key keeps
 * whatever is already on the variant.
 */
export function buildVariantMetafields(
  ctx: VariantMetafieldContext,
): ShopifyMetafieldInput[] {
  const out: ShopifyMetafieldInput[] = [];
  for (const field of VARIANT_METAFIELD_FIELDS) {
    const value = String(field.read(ctx) || "").trim().slice(0, VALUE_MAX);
    if (!value) continue;
    out.push({
      namespace: DEVJEWELS_METAFIELD_NAMESPACE,
      key: field.key,
      type: VARIANT_METAFIELD_TYPE,
      value,
    });
  }
  return out;
}

/** Every live piece of one design, as the product summary reads them. */
export type ProductMetafieldContext = {
  designNo: string;
  pieces: ChannelJobVariantDetails[];
};

export type ProductMetafieldField = {
  key: string;
  /** Merchant-facing label in Shopify admin — the stock table column name. */
  name: string;
  storefrontAccess: VariantMetafieldStorefrontAccess;
  read: (ctx: ProductMetafieldContext) => string | undefined;
};

/** Each distinct value across the pieces, sorted so a re-sync writes the same string. */
function distinct(
  pieces: ChannelJobVariantDetails[],
  pick: (d: ChannelJobVariantDetails) => string | undefined,
): string {
  const seen = new Map<string, string>();
  for (const piece of pieces) {
    const value = String(pick(piece) || "").trim();
    if (value && !seen.has(value.toLowerCase())) seen.set(value.toLowerCase(), value);
  }
  return [...seen.values()]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .join(", ");
}

/**
 * "13.102 – 14.61 gms" across the pieces, or the one weight when they agree.
 * Values arrive with their unit ("14.13 gms"); a mix of units, or a value that
 * is not a number, falls back to the distinct list rather than a wrong range.
 */
function weightRange(
  pieces: ChannelJobVariantDetails[],
  pick: (d: ChannelJobVariantDetails) => string | undefined,
): string {
  const parsed: Array<{ n: number; num: string; unit: string }> = [];
  for (const piece of pieces) {
    const raw = String(pick(piece) || "").trim();
    if (!raw) continue;
    const match = /^(\d+(?:\.\d+)?)\s*(.*)$/.exec(raw);
    if (!match) return distinct(pieces, pick);
    parsed.push({ n: Number(match[1]), num: match[1], unit: match[2].trim() });
  }
  if (!parsed.length) return "";
  if (new Set(parsed.map((p) => p.unit.toLowerCase())).size > 1) {
    return distinct(pieces, pick);
  }
  parsed.sort((a, b) => a.n - b.n);
  const low = parsed[0];
  const high = parsed[parsed.length - 1];
  const unit = low.unit ? ` ${low.unit}` : "";
  return low.n === high.n ? `${low.num}${unit}` : `${low.num} – ${high.num}${unit}`;
}

/**
 * The design's "Product Details" table, for a theme that hides job numbers.
 *
 * Job No, Store and Certificate belong to one piece, so they stay on the
 * variant only. Everything else is summarised across the live pieces.
 */
export const PRODUCT_METAFIELD_FIELDS: ProductMetafieldField[] = [
  { key: "design_no", name: "Design No", storefrontAccess: "PUBLIC_READ", read: (c) => c.designNo },
  {
    key: "category",
    name: "Category",
    storefrontAccess: "PUBLIC_READ",
    read: (c) => distinct(c.pieces, (d) => d.category),
  },
  {
    key: "metal",
    name: "Metal",
    storefrontAccess: "PUBLIC_READ",
    read: (c) => distinct(c.pieces, (d) => d.metal),
  },
  {
    key: "purity",
    name: "Quality",
    storefrontAccess: "PUBLIC_READ",
    read: (c) => distinct(c.pieces, (d) => d.purity),
  },
  {
    key: "color",
    name: "Color",
    storefrontAccess: "PUBLIC_READ",
    read: (c) => distinct(c.pieces, (d) => metalColorWord(d.color)),
  },
  {
    key: "diamond_type",
    name: "Type",
    storefrontAccess: "PUBLIC_READ",
    read: (c) => distinct(c.pieces, (d) => d.diamondType),
  },
  {
    key: "dia_qly",
    name: "Dia Quality",
    storefrontAccess: "PUBLIC_READ",
    read: (c) => distinct(c.pieces, (d) => d.diaQly),
  },
  {
    key: "dia_clr",
    name: "Dia Color",
    storefrontAccess: "PUBLIC_READ",
    read: (c) => distinct(c.pieces, (d) => d.diaClr),
  },
  {
    key: "gwt",
    name: "Gold WT",
    storefrontAccess: "PUBLIC_READ",
    read: (c) => weightRange(c.pieces, (d) => d.gwt),
  },
  {
    key: "nwt",
    name: "Net WT",
    storefrontAccess: "PUBLIC_READ",
    read: (c) => weightRange(c.pieces, (d) => d.nwt),
  },
  {
    key: "dwt",
    name: "Diamond WT",
    storefrontAccess: "PUBLIC_READ",
    read: (c) => weightRange(c.pieces, (d) => d.dwt),
  },
  {
    key: "swt",
    name: "Stone WT",
    storefrontAccess: "PUBLIC_READ",
    read: (c) => weightRange(c.pieces, (d) => d.swt),
  },
  {
    key: "size",
    name: "Size",
    storefrontAccess: "PUBLIC_READ",
    read: (c) => distinct(c.pieces, (d) => d.size),
  },
];

export type ProductMetafieldWrite = {
  set: ShopifyMetafieldInput[];
  /** Keys no live piece carries any more — their stale value must go. */
  clear: string[];
};

/**
 * Product metafields for one design.
 *
 * With no live pieces (an out-of-stock design sitting on its design_no
 * placeholder) only design_no is written and nothing is cleared: the merchant
 * still sells the design made to order, so its last known details stay up.
 */
export function buildProductMetafields(ctx: ProductMetafieldContext): ProductMetafieldWrite {
  const out: ProductMetafieldWrite = { set: [], clear: [] };
  const hasPieces = ctx.pieces.length > 0;
  for (const field of PRODUCT_METAFIELD_FIELDS) {
    if (!hasPieces && field.key !== "design_no") continue;
    const value = String(field.read(ctx) || "").trim().slice(0, VALUE_MAX);
    if (!value) {
      out.clear.push(field.key);
      continue;
    }
    out.set.push({
      namespace: DEVJEWELS_METAFIELD_NAMESPACE,
      key: field.key,
      type: VARIANT_METAFIELD_TYPE,
      value,
    });
  }
  return out;
}
