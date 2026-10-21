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

/**
 * Merchant- and storefront-visible product description block: one vertical
 * paragraph per job. Uses `<p>/<br>/<strong>` because theme RTE styles
 * (Dawn included) reflow or clip `<table>` inside the narrow product column.
 */
export function jobDetailsDescriptionHtml(
  designNo: string,
  variants: CreateProductInput["variants"],
): string | undefined {
  const rows = variants.slice(0, DESCRIPTION_JOB_CAP);
  if (!rows.length) return undefined;
  const lines: string[] = [
    `<h3>Design No: ${escapeHtml(designNo)}</h3>`,
  ];
  for (const v of rows) {
    const d = v.details || {};
    const fields = [
      ["Job No", v.jobNo],
      ["Metal", d.metal],
      ["Quality", d.purity],
      ["Color", d.color],
      ["Type", d.diamondType],
      ["Dia Quality", d.diaQly],
      ["Dia Color", d.diaClr],
      ["Gold WT", d.gwt],
      ["Diamond WT", d.dwt],
      ["Stone WT", d.swt],
      ["Net WT", d.nwt],
      ["Size", d.size],
      ["Store", d.store],
      ["Certificate", d.certificate],
      ["Category", d.category],
    ].filter((field): field is [string, string] => Boolean(field[1]?.trim()));
    lines.push(
      `<p>${fields
        .map(
          ([label, value]) =>
            `<strong>${label}:</strong> ${escapeHtml(value.trim())}`,
        )
        .join("<br>\n")}</p>`,
    );
  }
  if (variants.length > DESCRIPTION_JOB_CAP) {
    lines.push(
      `<p><em>+${variants.length - DESCRIPTION_JOB_CAP} more jobs — see variant metafields.</em></p>`,
    );
  }
  return lines.join("\n");
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

const PRODUCT_VARIANTS_FOR_RECLAIM = /* GraphQL */ `
  query productVariantsForReclaim($id: ID!) {
    product(id: $id) {
      id
      variants(first: 100) {
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

type ProductVariantsForReclaimData = {
  product?: {
    id?: string;
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

/** Load Job/SKU variants on a reclaimed product so retries update instead of re-create. */
export async function listShopifyVariantsForReclaim(
  client: ShopifyAdminClient,
  productId: string,
): Promise<
  Array<{
    jobNo: string;
    externalVariantId: string;
    externalInventoryItemId?: string;
  }>
> {
  const result = await client.graphql<ProductVariantsForReclaimData>(
    PRODUCT_VARIANTS_FOR_RECLAIM,
    { id: productId },
  );
  throwGraphqlErrors(result.errors);
  const nodes = result.data?.product?.variants?.nodes ?? [];
  const out: Array<{
    jobNo: string;
    externalVariantId: string;
    externalInventoryItemId?: string;
  }> = [];
  for (const n of nodes) {
    if (!n?.id) continue;
    const jobOpt = (n.selectedOptions || []).find(
      (o) => String(o?.name || "").trim().toLowerCase() === "job",
    );
    const jobNo = String(jobOpt?.value || n.sku || "").trim();
    if (!jobNo) continue;
    out.push({
      jobNo,
      externalVariantId: n.id,
      externalInventoryItemId: n.inventoryItem?.id || undefined,
    });
  }
  return out;
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
    const existingVariants = await listShopifyVariantsForReclaim(
      client,
      existingId,
    );
    return updateShopifyProduct(client, {
      ...input,
      externalProductId: existingId,
      existingVariants,
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
 * Update title/metafields; bulk-update prices on mapped variants;
 * bulk-create any new job_no variants not yet mapped;
 * bulk-delete stale placeholders / sold jobs (after desired variants exist).
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
  const existingByJob = new Map(
    (input.existingVariants ?? []).map((v) => [
      v.jobNo.trim().toUpperCase(),
      v,
    ]),
  );

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
  const removeIds = [
    ...new Set(
      (input.removeVariants ?? [])
        .map((v) => String(v.externalVariantId || "").trim())
        .filter(Boolean),
    ),
  ];
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
