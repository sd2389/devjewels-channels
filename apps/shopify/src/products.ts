/**
 * Shopify Admin product create/update (GraphQL).
 * Maps DevJewels design + job variants → Shopify product + variant/inventory ids.
 */
import type {
  ChannelJobVariantDetails,
  CreateProductInput,
  CreateProductResult,
  UpdateProductInput,
  UpdateProductResult,
} from "@devjewels-channels/core/channels/types";
import type { ShopifyAdminClient } from "./client";
import {
  buildVariantMetafields,
  DEVJEWELS_METAFIELD_NAMESPACE,
  type ShopifyMetafieldInput,
} from "./variantMetafieldSchema";
import { ShopifyHttpError } from "./client";

/** Shown on Shopify product Vendor — marks DevJewels catalog lines. */
export const DEVJEWELS_SHOPIFY_VENDOR = "Dev Jewels Inc.";

/**
 * First push is unpublished. Updates must not send status: once a merchant
 * sets the product Active, later syncs have to leave that choice in place.
 */
const NEW_SHOPIFY_PRODUCT_STATUS = "DRAFT";

/** Cap product description job rows (scale: avoid multi-MB HTML). */
const DESCRIPTION_JOB_CAP = 40;

function designMetafields(designNo: string) {
  return [
    {
      namespace: DEVJEWELS_METAFIELD_NAMESPACE,
      key: "design_no",
      type: "single_line_text_field",
      value: designNo,
    },
  ];
}

/** Variant metafields for one piece — see variantMetafieldSchema for the list. */
export function variantMetafields(
  designNo: string,
  jobNo: string,
  details?: ChannelJobVariantDetails,
): ShopifyMetafieldInput[] {
  return buildVariantMetafields({ designNo, jobNo, details });
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type DescriptionColumn = {
  label: string;
  /** Customer stock table always shows these, even when a cell is blank. */
  always: boolean;
  cell: (variant: CreateProductInput["variants"][number]) => string;
};

function descriptionCell(raw: string | undefined): string {
  return String(raw || "").trim();
}

/** Customer stock table price, e.g. 1650 → $1,650.00. */
export function formatDescriptionPrice(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "";
  const [whole, frac] = amount.toFixed(2).split(".");
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
}

/**
 * One row per in-stock piece, same columns as the customer stock table.
 * Job No is the piece. Metal, Quality, and Color use the same words as the picker.
 */
const DESCRIPTION_COLUMNS: DescriptionColumn[] = [
  { label: "Job No", always: true, cell: (v) => descriptionCell(v.jobNo) },
  { label: "Metal", always: true, cell: (v) => displayToken(v.details?.metal || "") },
  { label: "Quality", always: true, cell: (v) => displayToken(v.details?.purity || "") },
  { label: "Color", always: true, cell: (v) => displayToken(v.details?.color || "") },
  { label: "Type", always: false, cell: (v) => descriptionCell(v.details?.diamondType) },
  { label: "Dia Quality", always: true, cell: (v) => descriptionCell(v.details?.diaQly) },
  { label: "Dia Color", always: true, cell: (v) => descriptionCell(v.details?.diaClr) },
  { label: "Gold WT", always: true, cell: (v) => descriptionCell(v.details?.gwt) },
  { label: "Diamond WT", always: false, cell: (v) => descriptionCell(v.details?.dwt) },
  { label: "Stone WT", always: false, cell: (v) => descriptionCell(v.details?.swt) },
  { label: "Size", always: false, cell: (v) => descriptionCell(v.details?.size) },
  { label: "Store", always: false, cell: (v) => descriptionCell(v.details?.store) },
  {
    label: "Certificate",
    always: false,
    cell: (v) => descriptionCell(v.details?.certificate),
  },
  { label: "Price", always: true, cell: (v) => formatDescriptionPrice(v.price) },
];

/**
 * Product description as the customer stock table: one row per job.
 * `border` is an HTML attribute so the grid still shows if a theme strips CSS.
 */
export function jobDetailsDescriptionHtml(
  designNo: string,
  variants: CreateProductInput["variants"],
): string | undefined {
  const rows = variants.slice(0, DESCRIPTION_JOB_CAP);
  if (!rows.length) return undefined;
  const columns = DESCRIPTION_COLUMNS.filter(
    (column) => column.always || rows.some((row) => column.cell(row)),
  );
  const head = columns
    .map((column) => `<th>${escapeHtml(column.label)}</th>`)
    .join("");
  const body = rows
    .map((row) => {
      const cells = columns
        .map((column) => {
          const value = column.cell(row);
          return `<td>${value ? escapeHtml(value) : "—"}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("\n");
  const more =
    variants.length > DESCRIPTION_JOB_CAP
      ? `\n<p>+${variants.length - DESCRIPTION_JOB_CAP} more pieces are in stock.</p>`
      : "";
  const countLabel =
    variants.length > DESCRIPTION_JOB_CAP
      ? `${rows.length} of ${variants.length}`
      : String(rows.length);
  return `<h3>In Stock (${countLabel}) — ${escapeHtml(designNo)}</h3>
<table border="1" cellpadding="6" cellspacing="0">
<thead><tr>${head}</tr></thead>
<tbody>
${body}
</tbody>
</table>${more}`;
}

/** Customer-facing variant option. Legacy syncs used "Job" (the job number). */
export const STOREFRONT_OPTION = "Metal";
const LEGACY_JOB_OPTION = "Job";
/** Shopify's placeholder when a product has no real options. Themes hide this picker. */
const DEFAULT_OPTION = "Title";
const OPTION_VALUE_MAX = 255;

const COLOR_WORD: Record<string, string> = {
  w: "White",
  y: "Yellow",
  r: "Rose",
};

function displayToken(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .map((word) => {
      if (!word) return "";
      if (word.length === 1) {
        const mapped = COLOR_WORD[word.toLowerCase()];
        if (mapped) return mapped;
      }
      if (/\d/.test(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .filter(Boolean)
    .join(" ");
}

function clipOptionValue(raw: string): string {
  const s = raw.trim();
  return s.length <= OPTION_VALUE_MAX ? s : s.slice(0, OPTION_VALUE_MAX);
}

/**
 * What the customer should see for one piece: "14K White Gold", "18K Rose Gold", "Platinum".
 * Empty when the job has no metal, karat, or color.
 */
export function storefrontMetalLabel(details?: {
  metal?: string;
  purity?: string;
  color?: string;
}): string {
  const metal = displayToken(details?.metal || "");
  const purity = displayToken(details?.purity || "");
  const color = displayToken(details?.color || "");
  if (!metal && !purity && !color) return "";
  const colorInMetal =
    color.length > 0 && metal.toLowerCase().includes(color.toLowerCase());
  return [purity, colorInMetal ? "" : color, metal].filter(Boolean).join(" ");
}

/**
 * One picker when a design has two or more pieces. Values are metal + karat + color.
 * Same metal on two pieces adds size, then job number, so Shopify option values stay unique.
 * No metal data keeps the legacy Job option. A single piece returns null (picker hidden).
 */
export function storefrontOptionPlan(
  variants: Array<{
    jobNo: string;
    details?: { metal?: string; purity?: string; color?: string; size?: string };
  }>,
): { optionName: string; byJob: Map<string, string> } | null {
  const rows = variants
    .map((v) => ({
      jobNo: v.jobNo.trim(),
      base: storefrontMetalLabel(v.details),
      size: displayToken(v.details?.size || ""),
    }))
    .filter((r) => r.jobNo);
  if (rows.length < 2) return null;
  if (!rows.some((r) => r.base)) {
    return {
      optionName: LEGACY_JOB_OPTION,
      byJob: new Map(rows.map((r) => [r.jobNo, clipOptionValue(r.jobNo)])),
    };
  }
  const baseCount = new Map<string, number>();
  for (const r of rows) {
    const key = r.base.toLowerCase();
    baseCount.set(key, (baseCount.get(key) ?? 0) + 1);
  }
  const preliminary = rows.map((r) => {
    if (!r.base) return r.jobNo;
    const dup = (baseCount.get(r.base.toLowerCase()) ?? 0) > 1;
    if (!dup) return r.base;
    if (r.size) return `${r.base} · ${r.size}`;
    return `${r.base} · ${r.jobNo}`;
  });
  const seen = new Map<string, number>();
  const byJob = new Map<string, string>();
  rows.forEach((r, i) => {
    let label = preliminary[i] || r.jobNo;
    const key = label.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > 1) label = `${label} · ${r.jobNo}`;
    byJob.set(r.jobNo, clipOptionValue(label));
  });
  return { optionName: STOREFRONT_OPTION, byJob };
}

/** Stable Shopify tag for design lookup (retries / orphan recovery). */
export function designIdentityTag(designNo: string): string {
  return `dj_design:${normalizeDesignNoKey(designNo)}`;
}

export function normalizeDesignNoKey(designNo: string): string {
  return String(designNo || "")
    .replace(/\s+/g, "")
    .toUpperCase();
}

/** productType + tags for ProductCreateInput / ProductUpdateInput (skip empties). */
function shopifyTaxonomyFields(input: {
  designNo?: string;
  productType?: string;
  tags?: string[];
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const productType = String(input.productType || "").trim();
  if (productType) out.productType = productType;
  const tags = (input.tags || [])
    .map((t) => String(t || "").trim())
    .filter(Boolean);
  const designNo = String(input.designNo || "").trim();
  if (designNo) {
    const identity = designIdentityTag(designNo);
    if (!tags.some((t) => t.toLowerCase() === identity.toLowerCase())) {
      tags.push(identity);
    }
  }
  if (tags.length) out.tags = tags;
  return out;
}

function bulkVariantInput(
  designNo: string,
  v: CreateProductInput["variants"][number],
  option?: { name: string; value: string },
) {
  return {
    price: String(v.price),
    inventoryItem: { sku: v.sku || v.jobNo },
    metafields: variantMetafields(designNo, v.jobNo, v.details),
    ...(option
      ? { optionValues: [{ optionName: option.name, name: option.value }] }
      : {}),
  };
}

const PRODUCT_CREATE = /* GraphQL */ `
  mutation productCreate($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product {
        id
        variants(first: 100) {
          edges {
            node {
              id
              sku
              inventoryItem {
                id
              }
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const PRODUCT_UPDATE = /* GraphQL */ `
  mutation productUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const PRODUCT_VARIANTS_BULK_UPDATE = /* GraphQL */ `
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        sku
        inventoryItem {
          id
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const PRODUCT_VARIANTS_BULK_DELETE = /* GraphQL */ `
  mutation productVariantsBulkDelete($productId: ID!, $variantsIds: [ID!]!) {
    productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
      userErrors {
        field
        message
      }
    }
  }
`;

const PRODUCT_VARIANTS_BULK_CREATE = /* GraphQL */ `
  mutation productVariantsBulkCreate(
    $productId: ID!
    $variants: [ProductVariantsBulkInput!]!
    $strategy: ProductVariantsBulkCreateStrategy
  ) {
    productVariantsBulkCreate(
      productId: $productId
      variants: $variants
      strategy: $strategy
    ) {
      productVariants {
        id
        sku
        inventoryItem {
          id
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

type VariantNode = {
  id: string;
  sku?: string | null;
  inventoryItem?: { id: string } | null;
};

type ProductCreateData = {
  productCreate?: {
    product?: {
      id: string;
      variants?: {
        edges?: Array<{ node?: VariantNode | null }>;
      };
    } | null;
    userErrors?: Array<{ field?: string[]; message: string }>;
  };
};

type ProductUpdateData = {
  productUpdate?: {
    product?: { id: string } | null;
    userErrors?: Array<{ field?: string[]; message: string }>;
  };
};

type BulkVariantData = {
  productVariantsBulkUpdate?: {
    productVariants?: VariantNode[] | null;
    userErrors?: Array<{ field?: string[]; message: string }>;
  };
  productVariantsBulkCreate?: {
    productVariants?: VariantNode[] | null;
    userErrors?: Array<{ field?: string[]; message: string }>;
  };
};

function throwUserErrors(
  userErrors: Array<{ field?: string[]; message: string }> | undefined,
  label: string,
): void {
  if (!userErrors?.length) return;
  throw new ShopifyHttpError(
    422,
    userErrors.map((e) => e.message).join("; ") || `${label} userErrors`,
  );
}

function throwGraphqlErrors(
  errors: Array<{ message: string }> | undefined,
): void {
  if (!errors?.length) return;
  throw new ShopifyHttpError(
    502,
    errors.map((e) => e.message).join("; ") || "Shopify GraphQL errors",
  );
}

function matchVariants(
  inputVariants: CreateProductInput["variants"],
  nodes: VariantNode[],
): CreateProductResult["variants"] {
  return inputVariants.map((v, index) => {
    const bySku =
      nodes.find(
        (n) =>
          (n.sku || "").trim().toUpperCase() ===
          (v.sku || v.jobNo).trim().toUpperCase(),
      ) ?? nodes[index];
    if (!bySku?.id) {
      throw new ShopifyHttpError(
        502,
        `Shopify missing variant for job_no=${v.jobNo}`,
      );
    }
    return {
      jobNo: v.jobNo,
      externalVariantId: bySku.id,
      externalInventoryItemId: bySku.inventoryItem?.id,
    };
  });
}

const PRODUCTS_FIND_BY_DESIGN = /* GraphQL */ `
  query productsFindByDesign($query: String!) {
    products(first: 25, query: $query) {
      edges {
        node {
          id
          title
          createdAt
          totalVariants
          metafield(namespace: "devjewels", key: "design_no") {
            value
          }
        }
      }
    }
  }
`;

type ProductsFindByDesignData = {
  products?: {
    edges?: Array<{
      node?: {
        id?: string;
        title?: string;
        createdAt?: string;
        totalVariants?: number | null;
        metafield?: { value?: string | null } | null;
      } | null;
    } | null>;
  } | null;
};

function escapeShopifySearchValue(raw: string): string {
  return String(raw || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Find an existing DevJewels Shopify product for design_no.
 * Prefer identity tag; also match design/titleline titles + metafield (orphan recovery).
 */
export async function findShopifyProductByDesignNo(
  client: ShopifyAdminClient,
  designNo: string,
  options?: { titleHint?: string },
): Promise<string | null> {
  const key = normalizeDesignNoKey(designNo);
  if (!key) return null;
  const tag = designIdentityTag(designNo);
  const vendor = escapeShopifySearchValue(DEVJEWELS_SHOPIFY_VENDOR);
  const title = escapeShopifySearchValue(designNo.trim());
  const tagQ = escapeShopifySearchValue(tag);
  const titleHint = String(options?.titleHint || "").trim();
  const titleClauses = [`tag:"${tagQ}"`, `title:"${title}"`];
  if (titleHint && normalizeDesignNoKey(titleHint) !== key) {
    titleClauses.push(`title:"${escapeShopifySearchValue(titleHint)}"`);
  }
  // Legacy orphans often have titleline titles + design_no metafield only.
  const query = `vendor:"${vendor}" AND (${titleClauses.join(" OR ")})`;

  const result = await client.graphql<ProductsFindByDesignData>(
    PRODUCTS_FIND_BY_DESIGN,
    { query },
  );
  throwGraphqlErrors(result.errors);

  const nodes = (result.data?.products?.edges ?? [])
    .map((e) => e?.node)
    .filter((n): n is NonNullable<typeof n> => Boolean(n?.id));

  // Metafield is authoritative; design_no title is a fallback for older imports.
  const matches = nodes.filter((n) => {
    const mf = normalizeDesignNoKey(String(n.metafield?.value || ""));
    if (mf && mf === key) return true;
    return normalizeDesignNoKey(String(n.title || "")) === key;
  });
  if (!matches.length) return null;

  matches.sort((a, b) => {
    const va = Number(a.totalVariants ?? 0);
    const vb = Number(b.totalVariants ?? 0);
    if (vb !== va) return vb - va;
    return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
  });

  if (matches.length > 1) {
    console.warn("shopify_product_find_duplicates", {
      designNo: key,
      count: matches.length,
      kept: matches[0]?.id,
    });
  }
  return matches[0]?.id ?? null;
}

// ponytail: one page of variants (Shopify max 250); a design with more live jobs needs cursor paging.
const LIVE_VARIANT_PAGE = 250;

const PRODUCT_LIVE_STATE = /* GraphQL */ `
  query productLiveState($id: ID!) {
    product(id: $id) {
      id
      options {
        id
        name
        optionValues(first: ${LIVE_VARIANT_PAGE}) {
          nodes {
            id
            name
          }
        }
      }
      variants(first: ${LIVE_VARIANT_PAGE}) {
        nodes {
          id
          sku
          price
          selectedOptions {
            name
            value
          }
          inventoryItem {
            id
          }
        }
      }
    }
  }
`;

const PRODUCT_OPTIONS_CREATE = /* GraphQL */ `
  mutation productOptionsCreate(
    $productId: ID!
    $options: [OptionCreateInput!]!
    $variantStrategy: ProductOptionCreateVariantStrategy
  ) {
    productOptionsCreate(
      productId: $productId
      options: $options
      variantStrategy: $variantStrategy
    ) {
      userErrors {
        field
        message
      }
    }
  }
`;

type ProductLiveStateData = {
  product?: {
    id?: string;
    options?: Array<{
      id?: string | null;
      name?: string | null;
      optionValues?: {
        nodes?: Array<{ id?: string | null; name?: string | null } | null> | null;
      } | null;
    } | null> | null;
    variants?: {
      nodes?: Array<{
        id?: string;
        sku?: string | null;
        price?: string | null;
        selectedOptions?: Array<{ name?: string | null; value?: string | null }> | null;
        inventoryItem?: { id?: string } | null;
      } | null> | null;
    } | null;
  } | null;
};

type LiveOptionValue = { id?: string; name: string };

type LiveOption = {
  id?: string;
  name: string;
  values: LiveOptionValue[];
};

type LiveVariant = {
  jobNo: string;
  optionValue: string;
  externalVariantId: string;
  externalInventoryItemId?: string;
  /** Merchant's current selling price. New pieces inherit it; sync never rewrites it. */
  price?: string;
  /** Every option value Shopify holds for this variant, by option name. */
  selectedOptions: Array<{ name: string; value: string }>;
};

type LiveProductState = {
  options: LiveOption[];
  optionNames: string[];
  variants: LiveVariant[];
};

function isLegacyJobOption(name: string): boolean {
  return name.trim().toLowerCase() === LEGACY_JOB_OPTION.toLowerCase();
}

function isOwnedOption(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === STOREFRONT_OPTION.toLowerCase() || n === LEGACY_JOB_OPTION.toLowerCase();
}

const PRODUCT_OPTION_UPDATE = /* GraphQL */ `
  mutation productOptionUpdate(
    $productId: ID!
    $option: OptionUpdateInput!
    $optionValuesToUpdate: [OptionValueUpdateInput!]
  ) {
    productOptionUpdate(
      productId: $productId
      option: $option
      optionValuesToUpdate: $optionValuesToUpdate
    ) {
      userErrors {
        field
        message
      }
    }
  }
`;

const PRODUCT_OPTIONS_DELETE = /* GraphQL */ `
  mutation productOptionsDelete(
    $productId: ID!
    $options: [ID!]!
    $strategy: ProductOptionDeleteStrategy
  ) {
    productOptionsDelete(productId: $productId, options: $options, strategy: $strategy) {
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * What is on the Shopify product right now. Variant ids saved in Channels go
 * stale when the merchant edits variants or options in Shopify admin, so
 * updates reconcile against this instead. SKU is the job number; the option
 * value is the customer label.
 */
export async function readShopifyLiveProduct(
  client: ShopifyAdminClient,
  productId: string,
): Promise<LiveProductState> {
  const result = await client.graphql<ProductLiveStateData>(PRODUCT_LIVE_STATE, {
    id: productId,
  });
  throwGraphqlErrors(result.errors);
  const product = result.data?.product;
  if (!product?.id) {
    throw new ShopifyHttpError(404, "Shopify product not found");
  }
  const options: LiveOption[] = [];
  for (const o of product.options ?? []) {
    const name = String(o?.name || "").trim();
    if (!name) continue;
    const values: LiveOptionValue[] = [];
    for (const v of o?.optionValues?.nodes ?? []) {
      const valueName = String(v?.name || "").trim();
      if (!valueName) continue;
      values.push({ id: v?.id || undefined, name: valueName });
    }
    options.push({ id: o?.id || undefined, name, values });
  }
  const optionNames = options.map((o) => o.name);
  const variants: LiveVariant[] = [];
  for (const n of product.variants?.nodes ?? []) {
    if (!n?.id) continue;
    const selected = n.selectedOptions || [];
    const owned = selected.find((o) => isOwnedOption(String(o?.name || "")));
    const legacy = selected.find((o) => isLegacyJobOption(String(o?.name || "")));
    const sku = String(n.sku || "").trim();
    // Legacy products stored the job number in the Job option value and often also on SKU.
    const jobNo = sku || String(legacy?.value || "").trim();
    variants.push({
      jobNo,
      optionValue: String(owned?.value || "").trim(),
      externalVariantId: n.id,
      externalInventoryItemId: n.inventoryItem?.id || undefined,
      price: n.price == null ? undefined : String(n.price),
      selectedOptions: selected
        .map((o) => ({
          name: String(o?.name || "").trim(),
          value: String(o?.value || "").trim(),
        }))
        .filter((o) => o.name),
    });
  }
  return { options, optionNames, variants };
}

function indexLiveByJob(
  live: LiveProductState,
  desired: Array<{ jobNo: string }>,
): Map<string, LiveVariant> {
  const map = new Map<string, LiveVariant>();
  const used = new Set<string>();
  for (const v of live.variants) {
    const key = v.jobNo.trim().toUpperCase();
    if (!key || map.has(key)) continue;
    map.set(key, v);
    used.add(v.externalVariantId);
  }
  const unmatchedLive = live.variants.filter(
    (v) => !used.has(v.externalVariantId) && !v.jobNo.trim(),
  );
  const firstUnmatched = desired.find(
    (d) => !map.has(d.jobNo.trim().toUpperCase()),
  );
  if (unmatchedLive.length === 1 && firstUnmatched) {
    map.set(firstUnmatched.jobNo.trim().toUpperCase(), unmatchedLive[0]);
  }
  return map;
}

function optionValuesInSurvivorOrder(
  live: LiveProductState,
  variants: CreateProductInput["variants"],
  plan: NonNullable<ReturnType<typeof storefrontOptionPlan>>,
): string[] {
  const labels = variants.map((v) => plan.byJob.get(v.jobNo.trim()) || v.jobNo.trim());
  const survivor = live.variants.find((v) => v.jobNo.trim())?.jobNo.trim().toUpperCase();
  if (!survivor) return labels;
  const idx = variants.findIndex((v) => v.jobNo.trim().toUpperCase() === survivor);
  if (idx <= 0) return labels;
  const [hit] = labels.splice(idx, 1);
  return [hit, ...labels];
}

/**
 * Two or more pieces need one owned option (Metal, or Job when metal is unknown).
 * A product the merchant collapsed to Title gets that option back. LEAVE_AS_IS
 * links the surviving variant to the first value. Any other option is not guessed.
 */
async function ensureStorefrontOption(
  client: ShopifyAdminClient,
  productId: string,
  live: LiveProductState,
  variants: CreateProductInput["variants"],
  plan: NonNullable<ReturnType<typeof storefrontOptionPlan>>,
): Promise<LiveProductState> {
  const owned = live.options.find((o) => isOwnedOption(o.name));
  if (!owned) {
    const onlyDefault = live.optionNames.every((name) => name === DEFAULT_OPTION);
    if (!onlyDefault || live.variants.length > 1) {
      throw new ShopifyHttpError(
        409,
        `Shopify product options were changed (${live.optionNames.join(", ") || "none"}). ` +
          `DevJewels needs one "${plan.optionName}" option per piece; remove the other ` +
          "options in Shopify or delete the product so it re-imports.",
      );
    }
    console.warn("shopify_product_option_restored", {
      productId,
      optionName: plan.optionName,
      jobCount: variants.length,
    });
    const created = await client.graphql<{
      productOptionsCreate?: {
        userErrors?: Array<{ field?: string[]; message: string }>;
      };
    }>(PRODUCT_OPTIONS_CREATE, {
      productId,
      options: [
        {
          name: plan.optionName,
          values: optionValuesInSurvivorOrder(live, variants, plan).map((name) => ({ name })),
        },
      ],
      variantStrategy: "LEAVE_AS_IS",
    });
    throwGraphqlErrors(created.errors);
    throwUserErrors(created.data?.productOptionsCreate?.userErrors, "productOptionsCreate");
    live = await readShopifyLiveProduct(client, productId);
  }
  await relabelOwnedOption(client, productId, live, variants, plan);
  return live;
}

/** Rename Job → Metal and rewrite option values to the customer label. */
async function relabelOwnedOption(
  client: ShopifyAdminClient,
  productId: string,
  live: LiveProductState,
  variants: CreateProductInput["variants"],
  plan: NonNullable<ReturnType<typeof storefrontOptionPlan>>,
): Promise<void> {
  const owned = live.options.find((o) => isOwnedOption(o.name));
  if (!owned?.id) return;
  const desiredJobs = new Set(variants.map((v) => v.jobNo.trim().toUpperCase()));
  const targets = new Set(
    variants.map((v) => (plan.byJob.get(v.jobNo.trim()) || "").toLowerCase()),
  );
  const updates: Array<{ id: string; name: string }> = [];
  const usedValueIds = new Set<string>();
  for (const variant of live.variants) {
    const valueId = owned.values.find(
      (v) => v.name === variant.optionValue && v.id && !usedValueIds.has(v.id),
    )?.id;
    if (!valueId) continue;
    const jobKey = variant.jobNo.trim().toUpperCase();
    const desired = variants.find((v) => v.jobNo.trim().toUpperCase() === jobKey);
    let next = "";
    if (desired) {
      next = plan.byJob.get(desired.jobNo.trim()) || "";
    } else if (
      variant.optionValue &&
      targets.has(variant.optionValue.toLowerCase()) &&
      !desiredJobs.has(jobKey)
    ) {
      // A piece we are about to remove still holds the label a kept piece needs.
      next = variant.jobNo.trim() || valueId;
    }
    if (!next || next === variant.optionValue) continue;
    usedValueIds.add(valueId);
    updates.push({ id: valueId, name: clipOptionValue(next) });
  }
  const rename = owned.name !== plan.optionName;
  if (!rename && updates.length === 0) return;
  const updated = await client.graphql<{
    productOptionUpdate?: {
      userErrors?: Array<{ field?: string[]; message: string }>;
    };
  }>(PRODUCT_OPTION_UPDATE, {
    productId,
    option: { id: owned.id, name: plan.optionName },
    ...(updates.length ? { optionValuesToUpdate: updates } : {}),
  });
  throwGraphqlErrors(updated.errors);
  throwUserErrors(updated.data?.productOptionUpdate?.userErrors, "productOptionUpdate");
}

function rejectForeignOptions(live: LiveProductState, wantedOption: string): void {
  const owned = live.options.some((o) => isOwnedOption(o.name));
  const onlyDefault = live.optionNames.every((name) => name === DEFAULT_OPTION);
  if (owned || onlyDefault || live.optionNames.length === 0) return;
  throw new ShopifyHttpError(
    409,
    `Shopify product options were changed (${live.optionNames.join(", ")}). ` +
      `DevJewels needs one "${wantedOption}" option per piece; remove the other ` +
      "options in Shopify or delete the product so it re-imports.",
  );
}

/**
 * One piece uses Shopify's default Title variant, which themes do not render
 * as a picker. POSITION drops a Job/Metal option that still has leftover values
 * after the extra pieces are gone. One remaining variant is not a duplicate, so
 * it stays.
 */
async function hideSinglePieceOption(
  client: ShopifyAdminClient,
  productId: string,
  live: LiveProductState,
): Promise<void> {
  const ids = live.options
    .filter((o) => isOwnedOption(o.name) && o.id)
    .map((o) => o.id as string);
  if (!ids.length) return;
  const deleted = await client.graphql<{
    productOptionsDelete?: {
      userErrors?: Array<{ field?: string[]; message: string }>;
    };
  }>(PRODUCT_OPTIONS_DELETE, {
    productId,
    options: ids,
    strategy: "POSITION",
  });
  throwGraphqlErrors(deleted.errors);
  throwUserErrors(deleted.data?.productOptionsDelete?.userErrors, "productOptionsDelete");
}

export async function createShopifyProduct(
  client: ShopifyAdminClient,
  input: CreateProductInput,
): Promise<CreateProductResult> {
  if (!input.variants.length) {
    throw new ShopifyHttpError(400, "createProduct requires at least one variant");
  }

  // Root fix: never create a second Shopify product for the same design_no.
  // Retries after a failed create leave orphans; reclaim the fullest match.
  const existingId = await findShopifyProductByDesignNo(client, input.designNo, {
    titleHint: input.title,
  });
  if (existingId) {
    // An unmapped design that already exists in Shopify is almost always the
    // merchant's own product (a lost mapping, a reconnect, a second connection).
    // syncProductContent rides along on ...input, so reclaim goes down the same
    // live-stock-only path as any other update unless content sync is opted in.
    console.info("shopify_product_create_reclaim", {
      connectionId: input.connectionId,
      designNo: input.designNo,
      externalProductId: existingId,
      syncProductContent: input.syncProductContent === true,
    });
    if (input.onExternalProductId) {
      await input.onExternalProductId(existingId);
    }
    return updateShopifyProduct(client, {
      ...input,
      externalProductId: existingId,
    });
  }

  // Shopify 2024-10+: create the product shell, then write the variant.
  // One piece keeps Shopify's default Title variant so the theme hides the picker.
  // Two or more pieces get one Metal option (14K White Gold, …). Job number stays on SKU.
  const plan = storefrontOptionPlan(input.variants);
  const descriptionHtml = jobDetailsDescriptionHtml(input.designNo, input.variants);
  const result = await client.graphql<ProductCreateData>(PRODUCT_CREATE, {
    product: {
      title: input.title || input.designNo,
      vendor: DEVJEWELS_SHOPIFY_VENDOR,
      status: NEW_SHOPIFY_PRODUCT_STATUS,
      metafields: designMetafields(input.designNo),
      ...(descriptionHtml ? { descriptionHtml } : {}),
      ...shopifyTaxonomyFields(input),
      ...(plan
        ? {
            productOptions: [
              {
                name: plan.optionName,
                values: input.variants.map((v) => ({
                  name: plan.byJob.get(v.jobNo.trim()) || v.jobNo.trim(),
                })),
              },
            ],
          }
        : {}),
    },
  });

  throwGraphqlErrors(result.errors);
  const payload = result.data?.productCreate;
  throwUserErrors(payload?.userErrors, "productCreate");

  const product = payload?.product;
  if (!product?.id) {
    throw new ShopifyHttpError(502, "productCreate returned no product id");
  }

  // Map immediately so a later variant/media failure retries update, not create.
  if (input.onExternalProductId) {
    await input.onExternalProductId(product.id);
  }

  if (!plan) {
    const shellId = product.variants?.edges?.[0]?.node?.id;
    if (!shellId) {
      throw new ShopifyHttpError(502, "productCreate returned no variant");
    }
    const only = input.variants[0];
    const updated = await client.graphql<BulkVariantData>(PRODUCT_VARIANTS_BULK_UPDATE, {
      productId: product.id,
      variants: [
        {
          id: shellId,
          ...bulkVariantInput(input.designNo, only),
        },
      ],
    });
    throwGraphqlErrors(updated.errors);
    throwUserErrors(
      updated.data?.productVariantsBulkUpdate?.userErrors,
      "productVariantsBulkUpdate",
    );
    const nodes = updated.data?.productVariantsBulkUpdate?.productVariants ?? [];
    await attachShopifyProductImages(client, product.id, input.imageUrls, {
      replace: true,
    });
    return {
      externalProductId: product.id,
      variants: matchVariants(input.variants, nodes.length ? nodes : [{ id: shellId }]),
    };
  }

  const created = await client.graphql<BulkVariantData>(
    PRODUCT_VARIANTS_BULK_CREATE,
    {
      productId: product.id,
      strategy: "REMOVE_STANDALONE_VARIANT",
      variants: input.variants.map((v) =>
        bulkVariantInput(input.designNo, v, {
          name: plan.optionName,
          value: plan.byJob.get(v.jobNo.trim()) || v.jobNo.trim(),
        }),
      ),
    },
  );
  throwGraphqlErrors(created.errors);
  throwUserErrors(
    created.data?.productVariantsBulkCreate?.userErrors,
    "productVariantsBulkCreate",
  );

  const nodes = created.data?.productVariantsBulkCreate?.productVariants ?? [];
  await attachShopifyProductImages(client, product.id, input.imageUrls, {
    replace: true,
  });
  return {
    externalProductId: product.id,
    variants: matchVariants(input.variants, nodes),
  };
}

/* ------------------------------------------------------------------ *
 * Live-stock variant sync (merchant-owned catalog, the default path)
 * ------------------------------------------------------------------ */

function jobKey(raw: string): string {
  return String(raw || "").trim().toUpperCase();
}

export type LiveStockVariantPlan = {
  /** Job still in live stock and already on Shopify — qty + cost only. */
  keep: Array<{ jobNo: string; variant: LiveVariant }>;
  /** Job in live stock with no Shopify variant yet — a new piece to add. */
  create: string[];
  /** Our piece, sold out of live stock — the variant is removed from Shopify. */
  remove: LiveVariant[];
  /** Would be removed, but Shopify needs one variant — zeroed instead. */
  zero: LiveVariant[];
};

/**
 * Decide what happens to each Shopify variant from live stock alone.
 *
 * A design holds many pieces; a sold piece has to disappear from the storefront.
 * Only pieces Channels created (`ownedJobNos`, from `variant_mapping`) are ever
 * removed — a variant the merchant added themselves is left alone, and so is a
 * variant with no job number on its SKU. Shopify rejects a product with zero
 * variants, so the last survivor is zeroed rather than deleted.
 */
export function planLiveStockVariantSync(input: {
  live: LiveVariant[];
  /** Job numbers in live stock right now. */
  desiredJobNos: string[];
  /** Job numbers Channels has mapped for this design. */
  ownedJobNos: string[];
}): LiveStockVariantPlan {
  const desired = new Set(input.desiredJobNos.map(jobKey).filter(Boolean));
  const owned = new Set(input.ownedJobNos.map(jobKey).filter(Boolean));

  const keep: LiveStockVariantPlan["keep"] = [];
  const removable: LiveVariant[] = [];
  const seen = new Set<string>();

  for (const variant of input.live) {
    const key = jobKey(variant.jobNo);
    if (key && desired.has(key) && !seen.has(key)) {
      seen.add(key);
      keep.push({ jobNo: variant.jobNo.trim(), variant });
      continue;
    }
    // Only a piece that has genuinely left live stock is removed. A merchant
    // variant (no job SKU, or a SKU we never mapped) and a second copy of a
    // piece still in stock both stay put.
    if (key && owned.has(key) && !desired.has(key)) removable.push(variant);
  }

  const create = input.desiredJobNos
    .map((j) => j.trim())
    .filter((j) => j && !seen.has(jobKey(j)));

  // Shopify rejects a product with no variants. New pieces are added before old
  // ones are removed, so the guard only matters when nothing is being added.
  const survivors = input.live.length - removable.length;
  const zeroCount =
    create.length === 0 && survivors < 1
      ? Math.min(1 - survivors, removable.length)
      : 0;
  return {
    keep,
    create,
    remove: removable.slice(0, removable.length - zeroCount),
    zero: removable.slice(removable.length - zeroCount),
  };
}

/** Job attributes that can fill a product option when a new piece is added. */
const OPTION_VALUE_SOURCES: Array<{
  match: RegExp;
  pick: (details?: ChannelJobVariantDetails) => string;
}> = [
  { match: /^(metal|material)$/i, pick: (d) => storefrontMetalLabel(d) },
  {
    match: /^(karat|carat|kt|purity|quality)$/i,
    pick: (d) => displayToken(d?.purity || ""),
  },
  { match: /^colou?r$/i, pick: (d) => displayToken(d?.color || "") },
  { match: /^(size|length)$/i, pick: (d) => displayToken(d?.size || "") },
];

/**
 * Option values for a piece being added to a product the merchant now owns.
 * Returns null when an option cannot be filled from job data — guessing would
 * either collide with another piece or print something wrong on the storefront,
 * so the piece is reported instead of forced on.
 */
export function newVariantOptionValues(
  live: LiveProductState,
  job: { jobNo: string; details?: ChannelJobVariantDetails },
): Array<{ optionName: string; name: string }> | null {
  const named = live.options.filter((o) => o.name && o.name !== DEFAULT_OPTION);
  if (!named.length) return [];
  const out: Array<{ optionName: string; name: string }> = [];
  for (const option of named) {
    let value = "";
    if (isOwnedOption(option.name)) {
      value = isLegacyJobOption(option.name)
        ? job.jobNo.trim()
        : storefrontMetalLabel(job.details) || job.jobNo.trim();
    } else {
      value = OPTION_VALUE_SOURCES.find((s) => s.match.test(option.name))
        ?.pick(job.details) ?? "";
    }
    if (!value.trim()) return null;
    out.push({ optionName: option.name, name: clipOptionValue(value) });
  }
  return out;
}

/** Merchant's price for this design, so a new piece does not land at 0.00. */
function inheritedPrice(live: LiveVariant[], fallback: number): string {
  for (const v of live) {
    const n = Number(v.price);
    if (Number.isFinite(n) && n > 0) return String(v.price);
  }
  return String(fallback);
}

/**
 * The default update path: reconcile the live-stock variant set and nothing else.
 *
 * Writes only what DevJewels owns — which pieces exist, their job metafields and
 * their SKU. Never sends product title, description, tags, product type, status,
 * images, or the selling price of a variant that is already there, and never
 * touches the product's option structure. Safe to run against a product the
 * merchant has rebuilt in Shopify admin.
 */
export async function syncShopifyLiveStockVariants(
  client: ShopifyAdminClient,
  input: UpdateProductInput,
): Promise<UpdateProductResult> {
  const productId = input.externalProductId.trim();
  let live = await readShopifyLiveProduct(client, productId);

  const ownedJobNos = [
    ...(input.existingVariants ?? []),
    ...(input.removeVariants ?? []),
  ].map((v) => v.jobNo);

  // A design with no stock left arrives as a single design_no placeholder job.
  // On a product that already carries real pieces, adding it would wipe the
  // picker and replace it with a bare design code — the exact thing merchants
  // complained about — so the placeholder is dropped there and the real pieces
  // are zeroed instead. A product that never had pieces still gets it, so an
  // out-of-stock design has something to sit on.
  const ownedKeys = new Set(ownedJobNos.map(jobKey).filter(Boolean));
  const hasRealPieces = live.variants.some(
    (v) => jobKey(v.jobNo) && ownedKeys.has(jobKey(v.jobNo)),
  );
  const desiredJobNos = input.variants
    .map((v) => v.jobNo.trim())
    .filter(
      (j) => j && !(hasRealPieces && jobKey(j) === jobKey(input.designNo)),
    );

  const plan = planLiveStockVariantSync({
    live: live.variants,
    desiredJobNos,
    ownedJobNos,
  });

  const resultVariants: UpdateProductResult["variants"] = [];
  // Healing: saved ids go stale whenever the merchant rebuilds variants in
  // Shopify admin, so the live ids win and are handed back for re-mapping.
  for (const { jobNo, variant } of plan.keep) {
    resultVariants.push({
      jobNo,
      externalVariantId: variant.externalVariantId,
      externalInventoryItemId: variant.externalInventoryItemId,
    });
  }
  // Sold pieces come back too, with no live job behind them, so the caller
  // zeroes their quantity before Shopify can sell a piece that is gone.
  for (const variant of plan.zero) {
    resultVariants.push({
      jobNo: variant.jobNo,
      externalVariantId: variant.externalVariantId,
      externalInventoryItemId: variant.externalInventoryItemId,
    });
  }

  // Refresh the piece details on pieces already there. These are DevJewels
  // facts (certificate, weights, dia quality), so a correction upstream has to
  // reach the storefront; without this they were written once at add time and
  // then went stale forever. Metafields only — no price, no SKU, nothing the
  // merchant owns.
  const detailUpdates = plan.keep
    .map(({ jobNo, variant }) => {
      const job = input.variants.find((v) => jobKey(v.jobNo) === jobKey(jobNo));
      if (!job) return null;
      const metafields = variantMetafields(input.designNo, job.jobNo, job.details);
      if (!metafields.length) return null;
      return { id: variant.externalVariantId, metafields };
    })
    .filter((v): v is { id: string; metafields: ShopifyMetafieldInput[] } => v !== null);
  if (detailUpdates.length) {
    const refreshed = await client.graphql<BulkVariantData>(
      PRODUCT_VARIANTS_BULK_UPDATE,
      { productId, variants: detailUpdates },
    );
    throwGraphqlErrors(refreshed.errors);
    throwUserErrors(
      refreshed.data?.productVariantsBulkUpdate?.userErrors,
      "productVariantsBulkUpdate",
    );
  }

  if (plan.create.length) {
    // A product we created for a single piece sits on Shopify's "Title"
    // placeholder with no real option. A second piece cannot exist there, so
    // the picker has to be added — it overwrites nothing the merchant wrote.
    const hasRealOption = live.options.some(
      (o) => o.name && o.name !== DEFAULT_OPTION,
    );
    if (!hasRealOption && live.variants.length + plan.create.length > 1) {
      const labelFor = (job: { jobNo: string; details?: ChannelJobVariantDetails }) =>
        clipOptionValue(storefrontMetalLabel(job.details) || job.jobNo.trim());
      const existingLabels = plan.keep.map(({ variant }) => {
        const job = input.variants.find(
          (v) => jobKey(v.jobNo) === jobKey(variant.jobNo),
        );
        return job ? labelFor(job) : variant.jobNo.trim();
      });
      console.info("shopify_live_stock_option_added", {
        connectionId: input.connectionId,
        designNo: input.designNo,
        optionName: STOREFRONT_OPTION,
        pieces: live.variants.length + plan.create.length,
      });
      const createdOption = await client.graphql<{
        productOptionsCreate?: {
          userErrors?: Array<{ field?: string[]; message: string }>;
        };
      }>(PRODUCT_OPTIONS_CREATE, {
        productId,
        options: [
          {
            name: STOREFRONT_OPTION,
            values: (existingLabels.length ? existingLabels : ["Default"]).map(
              (name) => ({ name }),
            ),
          },
        ],
        variantStrategy: "LEAVE_AS_IS",
      });
      throwGraphqlErrors(createdOption.errors);
      throwUserErrors(
        createdOption.data?.productOptionsCreate?.userErrors,
        "productOptionsCreate",
      );
      live = await readShopifyLiveProduct(client, productId);
    }
    const byJob = new Map(
      input.variants.map((v) => [jobKey(v.jobNo), v] as const),
    );
    const creatable: Array<{
      job: UpdateProductInput["variants"][number];
      optionValues: Array<{ optionName: string; name: string }>;
    }> = [];
    const unfillable: string[] = [];
    for (const jobNo of plan.create) {
      const job = byJob.get(jobKey(jobNo));
      if (!job) continue;
      const optionValues = newVariantOptionValues(live, job);
      if (!optionValues) {
        unfillable.push(jobNo);
        continue;
      }
      creatable.push({ job, optionValues });
    }
    if (unfillable.length) {
      // Loud, not silent: the merchant changed the option structure to
      // something job data cannot fill, so these pieces need a human.
      console.warn("shopify_live_stock_variant_options_unfillable", {
        connectionId: input.connectionId,
        designNo: input.designNo,
        options: live.optionNames,
        jobNos: unfillable,
      });
    }
    if (creatable.length) {
      const price = inheritedPrice(live.variants, creatable[0].job.price);
      const created = await client.graphql<BulkVariantData>(
        PRODUCT_VARIANTS_BULK_CREATE,
        {
          productId,
          variants: creatable.map(({ job, optionValues }) => ({
            price,
            inventoryItem: { sku: job.sku || job.jobNo },
            metafields: variantMetafields(input.designNo, job.jobNo, job.details),
            ...(optionValues.length ? { optionValues } : {}),
          })),
        },
      );
      throwGraphqlErrors(created.errors);
      throwUserErrors(
        created.data?.productVariantsBulkCreate?.userErrors,
        "productVariantsBulkCreate",
      );
      const nodes = created.data?.productVariantsBulkCreate?.productVariants ?? [];
      resultVariants.push(
        ...matchVariants(
          creatable.map(({ job }) => job),
          nodes,
        ),
      );
    }
  }

  // Sold pieces leave last: a product must keep a variant at every step, and
  // new pieces are already in place by now.
  if (plan.remove.length) {
    const deleted = await client.graphql<{
      productVariantsBulkDelete?: {
        userErrors?: Array<{ field?: string[]; message: string }>;
      };
    }>(PRODUCT_VARIANTS_BULK_DELETE, {
      productId,
      variantsIds: plan.remove.map((v) => v.externalVariantId),
    });
    throwGraphqlErrors(deleted.errors);
    const fatal = (deleted.data?.productVariantsBulkDelete?.userErrors ?? []).filter(
      (e) => !/not found|does not exist|already been deleted/i.test(e.message),
    );
    if (fatal.length) throwUserErrors(fatal, "productVariantsBulkDelete");
    console.info("shopify_live_stock_variants_removed", {
      connectionId: input.connectionId,
      designNo: input.designNo,
      removed: plan.remove.length,
    });
  }


  return { externalProductId: productId, variants: resultVariants };
}

/**
 * Update title/metafields, then reconcile variants against the live Shopify
 * product (not saved Channels ids): bulk-update jobs already there, bulk-create
 * missing jobs, bulk-delete everything else (after desired variants exist).
 * input.existingVariants / removeVariants are ignored here; live state wins.
 */
export async function updateShopifyProduct(
  client: ShopifyAdminClient,
  input: UpdateProductInput,
): Promise<UpdateProductResult> {
  if (!input.externalProductId?.trim()) {
    throw new ShopifyHttpError(400, "updateProduct requires externalProductId");
  }
  if (!input.variants.length) {
    throw new ShopifyHttpError(400, "updateProduct requires at least one variant");
  }

  // Default for every shop: DevJewels owns live stock, the merchant owns the
  // storefront. Rewriting product content is opt-in here, not at the call site,
  // so a new caller cannot reintroduce the overwrite by forgetting a flag.
  if (input.syncProductContent !== true) {
    return syncShopifyLiveStockVariants(client, input);
  }

  const productId = input.externalProductId.trim();
  const plan = storefrontOptionPlan(input.variants);
  let live = await readShopifyLiveProduct(client, productId);
  rejectForeignOptions(live, plan?.optionName ?? STOREFRONT_OPTION);
  if (plan) {
    live = await ensureStorefrontOption(client, productId, live, input.variants, plan);
  }
  const existingByJob = indexLiveByJob(live, input.variants);

  const descriptionHtml = jobDetailsDescriptionHtml(input.designNo, input.variants);
  const updateResult = await client.graphql<ProductUpdateData>(PRODUCT_UPDATE, {
    product: {
      id: productId,
      title: input.title || input.designNo,
      vendor: DEVJEWELS_SHOPIFY_VENDOR,
      metafields: designMetafields(input.designNo),
      ...(descriptionHtml ? { descriptionHtml } : {}),
      ...shopifyTaxonomyFields(input),
    },
  });
  throwGraphqlErrors(updateResult.errors);
  throwUserErrors(updateResult.data?.productUpdate?.userErrors, "productUpdate");

  const toUpdate = input.variants.filter((v) =>
    existingByJob.has(v.jobNo.trim().toUpperCase()),
  );
  const toCreate = input.variants.filter(
    (v) => !existingByJob.has(v.jobNo.trim().toUpperCase()),
  );

  const resultVariants: UpdateProductResult["variants"] = [];

  if (toUpdate.length > 0) {
    const bulk = await client.graphql<BulkVariantData>(PRODUCT_VARIANTS_BULK_UPDATE, {
      productId,
      variants: toUpdate.map((v) => {
        const existing = existingByJob.get(v.jobNo.trim().toUpperCase())!;
        return {
          id: existing.externalVariantId,
          ...bulkVariantInput(
            input.designNo,
            v,
            plan
              ? {
                  name: plan.optionName,
                  value: plan.byJob.get(v.jobNo.trim()) || v.jobNo.trim(),
                }
              : undefined,
          ),
        };
      }),
    });
    throwGraphqlErrors(bulk.errors);
    throwUserErrors(
      bulk.data?.productVariantsBulkUpdate?.userErrors,
      "productVariantsBulkUpdate",
    );
    const nodes = bulk.data?.productVariantsBulkUpdate?.productVariants ?? [];
    for (const v of toUpdate) {
      const existing = existingByJob.get(v.jobNo.trim().toUpperCase())!;
      const node =
        nodes.find((n) => n.id === existing.externalVariantId) ??
        nodes.find(
          (n) =>
            (n.sku || "").trim().toUpperCase() ===
            (v.sku || v.jobNo).trim().toUpperCase(),
        );
      resultVariants.push({
        jobNo: v.jobNo,
        externalVariantId: node?.id ?? existing.externalVariantId,
        externalInventoryItemId:
          node?.inventoryItem?.id ?? existing.externalInventoryItemId,
      });
    }
  }

  if (toCreate.length > 0) {
    const bulk = await client.graphql<BulkVariantData>(PRODUCT_VARIANTS_BULK_CREATE, {
      productId,
      // Orphan reclaim (no mapped variants yet) must drop Shopify's default variant.
      ...(toUpdate.length === 0 ? { strategy: "REMOVE_STANDALONE_VARIANT" } : {}),
      variants: toCreate.map((v) =>
        bulkVariantInput(
          input.designNo,
          v,
          plan
            ? {
                name: plan.optionName,
                value: plan.byJob.get(v.jobNo.trim()) || v.jobNo.trim(),
              }
            : undefined,
        ),
      ),
    });
    throwGraphqlErrors(bulk.errors);
    throwUserErrors(
      bulk.data?.productVariantsBulkCreate?.userErrors,
      "productVariantsBulkCreate",
    );
    const nodes = bulk.data?.productVariantsBulkCreate?.productVariants ?? [];
    resultVariants.push(...matchVariants(toCreate, nodes));
  }

  // Delete after desired variants exist so the product never drops to zero variants.
  // Keep Channels variant_mapping rows for delayed order reverse-lookup; Shopify
  // delete is best-effort (already-removed variants must not fail the sync).
  const removeIds = live.variants.map((v) => v.externalVariantId);
  if (removeIds.length > 0 && resultVariants.length > 0) {
    const keepIds = new Set(resultVariants.map((v) => v.externalVariantId));
    const safeRemove = removeIds.filter((id) => !keepIds.has(id));
    if (safeRemove.length > 0) {
      const deleted = await client.graphql<{
        productVariantsBulkDelete?: {
          userErrors?: Array<{ field?: string[]; message: string }>;
        };
      }>(PRODUCT_VARIANTS_BULK_DELETE, {
        productId,
        variantsIds: safeRemove,
      });
      throwGraphqlErrors(deleted.errors);
      const deleteErrors =
        deleted.data?.productVariantsBulkDelete?.userErrors ?? [];
      const fatal = deleteErrors.filter(
        (e) => !/not found|does not exist|already been deleted/i.test(e.message),
      );
      if (fatal.length) {
        throwUserErrors(fatal, "productVariantsBulkDelete");
      }
    }
  }

  if (!plan) {
    await hideSinglePieceOption(client, productId, live);
  }

  await attachShopifyProductImages(client, productId, input.imageUrls, {
    replace: true,
  });
  return {
    externalProductId: productId,
    variants: resultVariants,
  };
}

const PRODUCT_MEDIA_LIST = /* GraphQL */ `
  query productMediaList($id: ID!) {
    product(id: $id) {
      id
      media(first: 50) {
        nodes {
          id
        }
      }
    }
  }
`;

const PRODUCT_DELETE_MEDIA = /* GraphQL */ `
  mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
    productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
      deletedMediaIds
      mediaUserErrors {
        field
        message
      }
    }
  }
`;

const PRODUCT_CREATE_MEDIA = /* GraphQL */ `
  mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media {
        ... on MediaImage {
          id
        }
      }
      mediaUserErrors {
        field
        message
      }
    }
  }
`;

type ProductMediaListData = {
  product?: {
    id?: string;
    media?: { nodes?: Array<{ id?: string }> };
  } | null;
};

type ProductDeleteMediaData = {
  productDeleteMedia?: {
    deletedMediaIds?: string[] | null;
    mediaUserErrors?: Array<{ field?: string[]; message: string }>;
  };
};

type ProductCreateMediaData = {
  productCreateMedia?: {
    media?: Array<{ id?: string } | null> | null;
    mediaUserErrors?: Array<{ field?: string[]; message: string }>;
  };
};

/**
 * Attach public CDN images to a Shopify product.
 * replace: delete existing media first so re-import picks up all metal colors.
 * Shopify fetches each originalSource; missing CDN paths return mediaUserErrors (non-fatal).
 */
export async function attachShopifyProductImages(
  client: ShopifyAdminClient,
  productId: string,
  imageUrls: string[] | undefined,
  options?: { force?: boolean; replace?: boolean },
): Promise<void> {
  const urls = (imageUrls || [])
    .map((u) => String(u || "").trim())
    .filter((u) => /^https?:\/\//i.test(u));
  if (!urls.length || !productId.trim()) return;

  console.info("shopify_product_media_attach", {
    productId,
    urlCount: urls.length,
    replace: Boolean(options?.replace || options?.force),
  });

  const listed = await client.graphql<ProductMediaListData>(PRODUCT_MEDIA_LIST, {
    id: productId,
  });
  throwGraphqlErrors(listed.errors);
  const existingIds =
    listed.data?.product?.media?.nodes
      ?.map((n) => n?.id)
      .filter((id): id is string => Boolean(id)) ?? [];

  if (!options?.force && !options?.replace && existingIds.length > 0) {
    return;
  }

  if ((options?.replace || options?.force) && existingIds.length > 0) {
    const deleted = await client.graphql<ProductDeleteMediaData>(
      PRODUCT_DELETE_MEDIA,
      { productId, mediaIds: existingIds },
    );
    throwGraphqlErrors(deleted.errors);
    const delErrs = deleted.data?.productDeleteMedia?.mediaUserErrors;
    if (delErrs?.length) {
      console.warn("shopify_product_media_delete_errors", {
        productId,
        message: delErrs.map((e) => e.message).join("; ").slice(0, 300),
      });
    }
  }

  const result = await client.graphql<ProductCreateMediaData>(
    PRODUCT_CREATE_MEDIA,
    {
      productId,
      media: urls.map((originalSource) => ({
        originalSource,
        mediaContentType: "IMAGE",
        alt: "Dev Jewels Inc.",
      })),
    },
  );
  throwGraphqlErrors(result.errors);
  const mediaErrors = result.data?.productCreateMedia?.mediaUserErrors;
  if (mediaErrors?.length) {
    console.warn("shopify_product_media_user_errors", {
      productId,
      message: mediaErrors.map((e) => e.message).join("; ").slice(0, 300),
    });
  }
}

const PRODUCT_DELETE = /* GraphQL */ `
  mutation productDelete($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors {
        field
        message
      }
    }
  }
`;

const PRODUCT_FOR_DELETE = /* GraphQL */ `
  query productForDelete($id: ID!) {
    product(id: $id) {
      id
    }
  }
`;

type ProductDeleteData = {
  productDelete?: {
    deletedProductId?: string | null;
    userErrors?: Array<{ field?: string[]; message: string }>;
  };
};

type ProductForDeleteData = {
  product?: { id?: string } | null;
};

export async function deleteShopifyProduct(
  client: ShopifyAdminClient,
  externalProductId: string,
): Promise<void> {
  const id = externalProductId.trim();
  if (!id) {
    throw new ShopifyHttpError(400, "deleteProduct requires externalProductId");
  }
  const existing = await client.graphql<ProductForDeleteData>(PRODUCT_FOR_DELETE, {
    id,
  });
  throwGraphqlErrors(existing.errors);
  if (!existing.data?.product?.id) {
    return;
  }
  const result = await client.graphql<ProductDeleteData>(PRODUCT_DELETE, {
    input: { id },
  });
  throwGraphqlErrors(result.errors);
  throwUserErrors(result.data?.productDelete?.userErrors, "productDelete");
  if (result.data?.productDelete?.deletedProductId !== id) {
    throw new ShopifyHttpError(502, "productDelete returned no matching product id");
  }
}
