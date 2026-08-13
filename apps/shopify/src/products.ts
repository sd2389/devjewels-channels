/**
 * Shopify Admin product create/update (GraphQL).
 * Maps DevJewels design + job variants → Shopify product + variant/inventory ids.
 */
import type {
  CreateProductInput,
  CreateProductResult,
  UpdateProductInput,
  UpdateProductResult,
} from "@devjewels-channels/core/channels/types";
import type { ShopifyAdminClient } from "./client";
import { ShopifyHttpError } from "./client";

const PRODUCT_CREATE = /* GraphQL */ `
  mutation productCreate($input: ProductInput!) {
    productCreate(input: $input) {
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
  mutation productUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
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
  mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) {
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

function variantMetafields(designNo: string, jobNo: string) {
  return [
    {
      namespace: "devjewels",
      key: "job_no",
      type: "single_line_text_field",
      value: jobNo,
    },
    {
      namespace: "devjewels",
      key: "design_no",
      type: "single_line_text_field",
      value: designNo,
    },
  ];
}

export async function createShopifyProduct(
  client: ShopifyAdminClient,
  input: CreateProductInput,
): Promise<CreateProductResult> {
  if (!input.variants.length) {
    throw new ShopifyHttpError(400, "createProduct requires at least one variant");
  }

  const result = await client.graphql<ProductCreateData>(PRODUCT_CREATE, {
    input: {
      title: input.title || input.designNo,
      status: "ACTIVE",
      variants: input.variants.map((v) => ({
        sku: v.sku || v.jobNo,
        price: String(v.price),
        metafields: variantMetafields(input.designNo, v.jobNo),
      })),
      metafields: designMetafields(input.designNo),
    },
  });

  throwGraphqlErrors(result.errors);
  const payload = result.data?.productCreate;
  throwUserErrors(payload?.userErrors, "productCreate");

  const product = payload?.product;
  if (!product?.id) {
    throw new ShopifyHttpError(502, "productCreate returned no product id");
  }

  const nodes =
    product.variants?.edges
      ?.map((e) => e.node)
      .filter((n): n is VariantNode => Boolean(n?.id)) ?? [];

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

  const updateResult = await client.graphql<ProductUpdateData>(PRODUCT_UPDATE, {
    input: {
      id: productId,
      title: input.title || input.designNo,
      status: "ACTIVE",
      metafields: designMetafields(input.designNo),
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
      variants: toCreate.map((v) => ({
        sku: v.sku || v.jobNo,
        price: String(v.price),
        metafields: variantMetafields(input.designNo, v.jobNo),
      })),
    });
    throwGraphqlErrors(bulk.errors);
    throwUserErrors(
      bulk.data?.productVariantsBulkCreate?.userErrors,
      "productVariantsBulkCreate",
    );
    const nodes = bulk.data?.productVariantsBulkCreate?.productVariants ?? [];
    resultVariants.push(...matchVariants(toCreate, nodes));
  }

  return {
    externalProductId: productId,
    variants: resultVariants,
  };
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

type ProductDeleteData = {
  productDelete?: {
    deletedProductId?: string | null;
    userErrors?: Array<{ field?: string[]; message: string }>;
  };
};

export async function deleteShopifyProduct(
  client: ShopifyAdminClient,
  externalProductId: string,
): Promise<void> {
  const id = externalProductId.trim();
  if (!id) {
    throw new ShopifyHttpError(400, "deleteProduct requires externalProductId");
  }
  const result = await client.graphql<ProductDeleteData>(PRODUCT_DELETE, {
    input: { id },
  });
  throwGraphqlErrors(result.errors);
  throwUserErrors(result.data?.productDelete?.userErrors, "productDelete");
}
