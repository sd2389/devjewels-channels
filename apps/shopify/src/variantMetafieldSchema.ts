/**
 * The piece details DevJewels publishes on every Shopify variant.
 *
 * One list, two readers: `variantMetafields` writes the values, and
 * `ensureShopifyVariantMetafieldDefinitions` declares them to Shopify so a theme
 * can read them. Keeping both off this list stops the two from drifting apart —
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
