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

type ShopifyMetafieldInput = {
  namespace: string;
  key: string;
  type: string;
  value: string;
};

function pushMetafield(
  out: ShopifyMetafieldInput[],
  key: string,
  value: string | undefined,
): void {
  const v = String(value || "").trim();
  if (!v) return;
  out.push({
    namespace: "devjewels",
    key,
    type: "single_line_text_field",
    value: v,
  });
}

function designMetafields(designNo: string) {
  return [
    {
      namespace: "devjewels",
      key: "design_no",
      type: "single_line_text_field",
      value: designNo,
    },
  ];
}

/**
 * Variant metafields under namespace `devjewels`.
 * Keys mirror DevJewels UI labels (Job No, Store, Metal, …).
 */
export function variantMetafields(
  designNo: string,
  jobNo: string,
  details?: ChannelJobVariantDetails,
): ShopifyMetafieldInput[] {
  const out: ShopifyMetafieldInput[] = [];
  pushMetafield(out, "job_no", jobNo);
  pushMetafield(out, "design_no", designNo);
  pushMetafield(out, "store", details?.store);
  pushMetafield(out, "category", details?.category);
  pushMetafield(out, "metal", details?.metal);
  pushMetafield(out, "purity", details?.purity);
  pushMetafield(out, "color", details?.color);
  pushMetafield(out, "dia_qly", details?.diaQly);
  pushMetafield(out, "dia_clr", details?.diaClr);
  pushMetafield(out, "diamond_type", details?.diamondType);
  pushMetafield(out, "size", details?.size);
  pushMetafield(out, "gwt", details?.gwt);
  pushMetafield(out, "nwt", details?.nwt);
  pushMetafield(out, "dwt", details?.dwt);
  pushMetafield(out, "swt", details?.swt);
  pushMetafield(out, "certificate", details?.certificate?.slice(0, 255));
  return out;
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

/** Same columns as the customer product-page stock table, in that order. */
const DESCRIPTION_COLUMNS: DescriptionColumn[] = [
  { label: "Job No", always: true, cell: (v) => descriptionCell(v.jobNo) },
  { label: "Metal", always: true, cell: (v) => descriptionCell(v.details?.metal) },
  { label: "Quality", always: true, cell: (v) => descriptionCell(v.details?.purity) },
  { label: "Color", always: true, cell: (v) => descriptionCell(v.details?.color) },
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
      ? `\n<p>+${variants.length - DESCRIPTION_JOB_CAP} more jobs are on the variants.</p>`
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
  withOption: boolean,
) {
  return {
    price: String(v.price),
    inventoryItem: { sku: v.sku || v.jobNo },
    metafields: variantMetafields(designNo, v.jobNo, v.details),
    ...(withOption
      ? { optionValues: [{ optionName: "Job", name: v.jobNo }] }
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
        name
      }
      variants(first: ${LIVE_VARIANT_PAGE}) {
        nodes {
          id
          sku
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
    options?: Array<{ name?: string | null } | null> | null;
    variants?: {
      nodes?: Array<{
        id?: string;
        sku?: string | null;
        selectedOptions?: Array<{ name?: string | null; value?: string | null }> | null;
        inventoryItem?: { id?: string } | null;
      } | null> | null;
    } | null;
  } | null;
};

type LiveVariant = {
  jobNo: string;
  externalVariantId: string;
  externalInventoryItemId?: string;
};

type LiveProductState = {
  optionNames: string[];
  variants: LiveVariant[];
};

const JOB_OPTION = "Job";
/** Option Shopify gives a product that has no options (single "Default Title" variant). */
const DEFAULT_OPTION = "Title";

function isJobOption(name: string): boolean {
  return name.trim().toLowerCase() === JOB_OPTION.toLowerCase();
}

/**
 * What is on the Shopify product right now. Variant ids saved in Channels go
 * stale when the merchant edits variants or options in Shopify admin, so
 * updates reconcile against this instead.
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
  const optionNames = (product.options ?? [])
    .map((o) => String(o?.name || "").trim())
    .filter(Boolean);
  const variants: LiveVariant[] = [];
  for (const n of product.variants?.nodes ?? []) {
    if (!n?.id) continue;
    const jobOpt = (n.selectedOptions || []).find((o) =>
      isJobOption(String(o?.name || "")),
    );
    const jobNo = String(jobOpt?.value || n.sku || "").trim();
    variants.push({
      jobNo,
      externalVariantId: n.id,
      externalInventoryItemId: n.inventoryItem?.id || undefined,
    });
  }
  return { optionNames, variants };
}

/**
 * Put the Job option back when the merchant removed it (product collapsed to
 * one default variant). LEAVE_AS_IS links that variant to the first job, so
 * the remaining jobs can be bulk-created. Other merchant options are not
 * guessed at: the product needs fixing in Shopify (or deleting to re-import).
 */
async function ensureJobOption(
  client: ShopifyAdminClient,
  productId: string,
  live: LiveProductState,
  jobNos: string[],
): Promise<LiveProductState> {
  if (live.optionNames.some(isJobOption)) return live;
  const onlyDefault = live.optionNames.every((name) => name === DEFAULT_OPTION);
  if (!onlyDefault || live.variants.length > 1) {
    throw new ShopifyHttpError(
      409,
      `Shopify product options were changed (${live.optionNames.join(", ")}). ` +
        `DevJewels needs one "${JOB_OPTION}" option per piece; remove the other ` +
        "options in Shopify or delete the product so it re-imports.",
    );
  }
  console.warn("shopify_product_job_option_restored", {
    productId,
    jobCount: jobNos.length,
  });
  const created = await client.graphql<{
    productOptionsCreate?: {
      userErrors?: Array<{ field?: string[]; message: string }>;
    };
  }>(PRODUCT_OPTIONS_CREATE, {
    productId,
    options: [{ name: JOB_OPTION, values: jobNos.map((name) => ({ name })) }],
    variantStrategy: "LEAVE_AS_IS",
  });
  throwGraphqlErrors(created.errors);
  throwUserErrors(created.data?.productOptionsCreate?.userErrors, "productOptionsCreate");
  return readShopifyLiveProduct(client, productId);
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
    console.info("shopify_product_create_reclaim", {
      connectionId: input.connectionId,
      designNo: input.designNo,
      externalProductId: existingId,
    });
    if (input.onExternalProductId) {
      await input.onExternalProductId(existingId);
    }
    return updateShopifyProduct(client, {
      ...input,
      externalProductId: existingId,
    });
  }

  // Shopify 2024-10+: create product shell, then variants via bulk APIs.
  // SKU lives on inventoryItem. Always create a "Job" option, including
  // single-variant / OOS placeholders, so a later live job can bulk-create
  // without productVariantsBulkCreate failing on a missing option.
  const descriptionHtml = jobDetailsDescriptionHtml(input.designNo, input.variants);
  const result = await client.graphql<ProductCreateData>(PRODUCT_CREATE, {
    product: {
      title: input.title || input.designNo,
      vendor: DEVJEWELS_SHOPIFY_VENDOR,
      status: NEW_SHOPIFY_PRODUCT_STATUS,
      metafields: designMetafields(input.designNo),
      ...(descriptionHtml ? { descriptionHtml } : {}),
      ...shopifyTaxonomyFields(input),
      productOptions: [
        {
          name: "Job",
          values: input.variants.map((v) => ({ name: v.jobNo })),
        },
      ],
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

  const created = await client.graphql<BulkVariantData>(
    PRODUCT_VARIANTS_BULK_CREATE,
    {
      productId: product.id,
      strategy: "REMOVE_STANDALONE_VARIANT",
      variants: input.variants.map((v) =>
        bulkVariantInput(input.designNo, v, true),
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

  const productId = input.externalProductId.trim();
  const live = await ensureJobOption(
    client,
    productId,
    await readShopifyLiveProduct(client, productId),
    input.variants.map((v) => v.jobNo),
  );
  const existingByJob = new Map<string, LiveVariant>();
  for (const v of live.variants) {
    const key = v.jobNo.trim().toUpperCase();
    if (key && !existingByJob.has(key)) existingByJob.set(key, v);
  }

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
          price: String(v.price),
          inventoryItem: { sku: v.sku || v.jobNo },
          metafields: variantMetafields(input.designNo, v.jobNo, v.details),
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
      variants: toCreate.map((v) => bulkVariantInput(input.designNo, v, true)),
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
