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
  pushMetafield(out, "size", details?.size);
  pushMetafield(out, "gwt", details?.gwt);
  pushMetafield(out, "nwt", details?.nwt);
  pushMetafield(out, "dwt", details?.dwt);
  return out;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Merchant-visible product description block (job detail lines). */
export function jobDetailsDescriptionHtml(
  designNo: string,
  variants: CreateProductInput["variants"],
): string | undefined {
  const rows = variants.slice(0, DESCRIPTION_JOB_CAP);
  if (!rows.length) return undefined;
  const lines: string[] = [
    `<p><strong>Design No:</strong> ${escapeHtml(designNo)}</p>`,
  ];
  for (const v of rows) {
    const d = v.details || {};
    const parts: string[] = [`Job No: ${escapeHtml(v.jobNo)}`];
    if (d.store) parts.push(`Store: ${escapeHtml(d.store)}`);
    if (d.category) parts.push(`Category: ${escapeHtml(d.category)}`);
    if (d.metal) parts.push(`Metal: ${escapeHtml(d.metal)}`);
    if (d.purity) parts.push(`Purity: ${escapeHtml(d.purity)}`);
    if (d.color) parts.push(`Color: ${escapeHtml(d.color)}`);
    if (d.diaQly) parts.push(`Dia. Qly: ${escapeHtml(d.diaQly)}`);
    if (d.diaClr) parts.push(`Dia. Clr: ${escapeHtml(d.diaClr)}`);
    if (d.size) parts.push(`Size: ${escapeHtml(d.size)}`);
    if (d.gwt) parts.push(`Gwt: ${escapeHtml(d.gwt)}`);
    if (d.nwt) parts.push(`Nwt: ${escapeHtml(d.nwt)}`);
    if (d.dwt) parts.push(`Dwt: ${escapeHtml(d.dwt)}`);
    lines.push(`<p>${parts.join(" · ")}</p>`);
  }
  if (variants.length > DESCRIPTION_JOB_CAP) {
    lines.push(
      `<p><em>+${variants.length - DESCRIPTION_JOB_CAP} more jobs — see variant metafields.</em></p>`,
    );
  }
  return lines.join("\n");
}

/** productType + tags for ProductCreateInput / ProductUpdateInput (skip empties). */
function shopifyTaxonomyFields(input: {
  productType?: string;
  tags?: string[];
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const productType = String(input.productType || "").trim();
  if (productType) out.productType = productType;
  const tags = (input.tags || [])
    .map((t) => String(t || "").trim())
    .filter(Boolean);
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

export async function createShopifyProduct(
  client: ShopifyAdminClient,
  input: CreateProductInput,
): Promise<CreateProductResult> {
  if (!input.variants.length) {
    throw new ShopifyHttpError(400, "createProduct requires at least one variant");
  }

  // Shopify 2024-10+: create product shell, then variants via bulk APIs.
  // SKU lives on inventoryItem; multi-job designs use a "Job" option.
  const multi = input.variants.length > 1;
  const descriptionHtml = jobDetailsDescriptionHtml(input.designNo, input.variants);
  const result = await client.graphql<ProductCreateData>(PRODUCT_CREATE, {
    product: {
      title: input.title || input.designNo,
      vendor: DEVJEWELS_SHOPIFY_VENDOR,
      status: "ACTIVE",
      metafields: designMetafields(input.designNo),
      ...(descriptionHtml ? { descriptionHtml } : {}),
      ...shopifyTaxonomyFields(input),
      ...(multi
        ? {
            productOptions: [
              {
                name: "Job",
                values: input.variants.map((v) => ({ name: v.jobNo })),
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

  const created = await client.graphql<BulkVariantData>(
    PRODUCT_VARIANTS_BULK_CREATE,
    {
      productId: product.id,
      strategy: "REMOVE_STANDALONE_VARIANT",
      variants: input.variants.map((v) =>
        bulkVariantInput(input.designNo, v, multi),
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
 * bulk-create any new job_no variants not yet mapped.
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
      status: "ACTIVE",
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
