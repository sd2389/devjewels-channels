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
 */
import type { ChannelJobVariantDetails } from "@devjewels-channels/core/channels/types";

export const DEVJEWELS_METAFIELD_NAMESPACE = "devjewels";

/** Shopify owner type for a variant-scoped metafield definition. */
export const VARIANT_METAFIELD_OWNER_TYPE = "PRODUCTVARIANT";

export const VARIANT_METAFIELD_TYPE = "single_line_text_field";

/** Shopify caps a single_line_text_field at 255 characters. */
const VALUE_MAX = 255;

export type VariantMetafieldContext = {
  designNo: string;
  jobNo: string;
  details?: ChannelJobVariantDetails;
};

export type VariantMetafieldField = {
  key: string;
  /** Merchant-facing label in Shopify admin — the stock table column name. */
  name: string;
  read: (ctx: VariantMetafieldContext) => string | undefined;
};

export const VARIANT_METAFIELD_FIELDS: VariantMetafieldField[] = [
  { key: "job_no", name: "Job No", read: (c) => c.jobNo },
  { key: "design_no", name: "Design No", read: (c) => c.designNo },
  { key: "metal", name: "Metal", read: (c) => c.details?.metal },
  { key: "purity", name: "Quality", read: (c) => c.details?.purity },
  { key: "color", name: "Color", read: (c) => c.details?.color },
  { key: "diamond_type", name: "Type", read: (c) => c.details?.diamondType },
  { key: "dia_qly", name: "Dia Quality", read: (c) => c.details?.diaQly },
  { key: "dia_clr", name: "Dia Color", read: (c) => c.details?.diaClr },
  { key: "gwt", name: "Gold WT", read: (c) => c.details?.gwt },
  { key: "nwt", name: "Net WT", read: (c) => c.details?.nwt },
  { key: "dwt", name: "Diamond WT", read: (c) => c.details?.dwt },
  { key: "swt", name: "Stone WT", read: (c) => c.details?.swt },
  { key: "size", name: "Size", read: (c) => c.details?.size },
  { key: "store", name: "Store", read: (c) => c.details?.store },
  { key: "category", name: "Category", read: (c) => c.details?.category },
  { key: "certificate", name: "Certificate", read: (c) => c.details?.certificate },
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
