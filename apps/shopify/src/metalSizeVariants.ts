/**
 * Write a Metal × Size plan to one Shopify product in a single productSet:
 * options exactly Metal (+ Size), one variant per slot, then quantities,
 * the design's product metafields and, if opted in, the stock table
 * description.
 *
 * productSet replaces list fields wholesale, so this sends only options and
 * variants — never product metafields (that would delete the merchant's own
 * custom.* fields), files, tags or status on an existing product.
 *
 * Price: a variant already on the product keeps the merchant's price; a new
 * one gets the slot price. Quantity is the slot's live piece count, and every
 * variant is DENY, so a combination with no piece is listed sold out.
 */
import type {
  SyncMetalSizeVariantsInput,
  SyncMetalSizeVariantsResult,
} from "@devjewels-channels/core/channels/types";
import type { ShopifyAdminClient } from "./client";
import { ShopifyHttpError } from "./client";
import { setShopifyInventoryLevels } from "./inventory";
import { METAL_OPTION, SIZE_OPTION } from "./metalSizeSlots";
import {
  attachShopifyProductImages,
  DEVJEWELS_SHOPIFY_VENDOR,
  findShopifyProductByDesignNo,
  NEW_SHOPIFY_PRODUCT_STATUS,
  readShopifyLiveProduct,
  shopifyTaxonomyFields,
  throwGraphqlErrors,
  throwUserErrors,
  variantMetafields,
  writeShopifyProductDetails,
} from "./products";
import { writeShopifyStockDescription } from "./stockDescription";

const PRODUCT_SET = /* GraphQL */ `
  mutation productSet($input: ProductSetInput!, $synchronous: Boolean!) {
    productSet(input: $input, synchronous: $synchronous) {
      product {
        id
        variants(first: 250) {
          nodes {
            id
            sku
            inventoryItem {
              id
            }
          }
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

type ProductSetData = {
  productSet?: {
    product?: {
      id?: string;
      variants?: {
        nodes?: Array<{ id?: string; sku?: string | null; inventoryItem?: { id?: string } | null } | null>;
      } | null;
    } | null;
    userErrors?: Array<{ field?: string[]; message: string; code?: string }>;
  };
};

/** Options this layout replaces without asking: ours, and the merchant's metal/karat split. */
const REPLACEABLE_OPTIONS = /^(title|job|metal|metal[\s_-]*(type|colou?r)|karat|carat|kt|purity|quality|(ring[\s_-]*)?size)$/i;

function money(amount: number): string {
  return Number.isFinite(amount) && amount > 0 ? amount.toFixed(2) : "0.00";
}

export async function syncShopifyMetalSizeVariants(
  client: ShopifyAdminClient,
  input: SyncMetalSizeVariantsInput & { locationId: string },
): Promise<SyncMetalSizeVariantsResult> {
  const { plan, designNo } = input;
  if (!plan.slots.length) {
    throw new ShopifyHttpError(400, "metal_size sync needs at least one slot");
  }

  let productId = input.externalProductId?.trim() || "";
  if (!productId) {
    productId =
      (await findShopifyProductByDesignNo(client, designNo, { titleHint: input.title })) || "";
  }
  const live = productId ? await readShopifyLiveProduct(client, productId) : null;

  if (live) {
    const dropped = live.options
      .map((o) => o.name)
      .filter((name) => !REPLACEABLE_OPTIONS.test(name.trim()));
    if (dropped.length) {
      console.warn("shopify_metal_size_options_dropped", {
        connectionId: input.connectionId,
        designNo,
        options: dropped,
      });
    }
  }

  const liveBySku = new Map(
    (live?.variants ?? [])
      .filter((v) => v.jobNo)
      .map((v) => [v.jobNo.trim().toUpperCase(), v] as const),
  );

  const productOptions = [
    {
      name: METAL_OPTION,
      position: 1,
      values: plan.metalValues.map((name) => ({ name })),
    },
    ...(plan.sizeValues.length
      ? [{ name: SIZE_OPTION, position: 2, values: plan.sizeValues.map((name) => ({ name })) }]
      : []),
  ];

  const variants = plan.slots.map((slot) => {
    const existing = liveBySku.get(slot.sku.toUpperCase());
    const backing = slot.pieces[0];
    const cost = backing?.wholesaleCost;
    return {
      ...(existing ? { id: existing.externalVariantId } : {}),
      optionValues: [
        { optionName: METAL_OPTION, name: slot.metal },
        ...(slot.size ? [{ optionName: SIZE_OPTION, name: slot.size }] : []),
      ],
      price: existing?.price ?? money(slot.price),
      sku: slot.sku,
      inventoryPolicy: "DENY",
      inventoryItem: {
        tracked: true,
        ...(input.includeCost && cost != null && Number.isFinite(cost) && cost > 0
          ? { cost: cost.toFixed(2) }
          : {}),
      },
      metafields: backing
        ? variantMetafields(designNo, backing.jobNo, backing.details)
        : variantMetafields(designNo, "", { size: slot.size }),
    };
  });

  const setInput = productId
    ? { id: productId, productOptions, variants }
    : {
        title: input.title || designNo,
        vendor: DEVJEWELS_SHOPIFY_VENDOR,
        status: NEW_SHOPIFY_PRODUCT_STATUS,
        ...shopifyTaxonomyFields(input),
        productOptions,
        variants,
      };

  const set = await client.graphql<ProductSetData>(PRODUCT_SET, {
    input: setInput,
    synchronous: true,
  });
  throwGraphqlErrors(set.errors);
  throwUserErrors(set.data?.productSet?.userErrors, "productSet");
  const product = set.data?.productSet?.product;
  if (!product?.id) {
    throw new ShopifyHttpError(502, "productSet returned no product id");
  }
  const created = !productId;
  productId = product.id;
  if (created && input.onExternalProductId) {
    await input.onExternalProductId(productId);
  }

  const nodesBySku = new Map(
    (product.variants?.nodes ?? [])
      .filter((n): n is NonNullable<typeof n> => Boolean(n?.id))
      .map((n) => [String(n.sku || "").trim().toUpperCase(), n] as const),
  );
  const slots = plan.slots.map((slot) => {
    const node = nodesBySku.get(slot.sku.toUpperCase());
    if (!node?.id) {
      throw new ShopifyHttpError(502, `productSet returned no variant for ${slot.sku}`);
    }
    return {
      key: slot.key,
      sku: slot.sku,
      externalVariantId: node.id,
      externalInventoryItemId: node.inventoryItem?.id || undefined,
      jobNos: slot.pieces.map((p) => p.jobNo),
      quantity: slot.quantity,
    };
  });

  if (input.writeInventory) await setShopifyInventoryLevels(client, {
    locationId: input.locationId,
    items: slots
      .filter((s) => s.externalInventoryItemId)
      .map((s) => ({ inventoryItemId: s.externalInventoryItemId!, available: s.quantity })),
  });

  if (created) {
    await attachShopifyProductImages(client, productId, input.imageUrls, { replace: true });
  }

  // Every live piece, cheapest first: the product summary and the table read the same list.
  const pieces = plan.slots
    .flatMap((s) => s.pieces)
    .sort((a, b) => a.price - b.price || a.jobNo.localeCompare(b.jobNo, undefined, { numeric: true }));
  await writeShopifyProductDetails(client, productId, {
    designNo,
    variants: pieces.map((p) => ({ jobNo: p.jobNo, details: p.details })),
  });
  if (input.syncProductDescription) {
    await writeShopifyStockDescription(client, productId, designNo, pieces);
  }

  console.info("shopify_metal_size_sync_ok", {
    connectionId: input.connectionId,
    designNo,
    externalProductId: productId,
    created,
    variants: slots.length,
    inStock: slots.filter((s) => s.quantity > 0).length,
    pieces: pieces.length,
    unplaced: plan.unplaced.length,
  });

  return {
    externalProductId: productId,
    slots: slots.map(({ quantity: _q, ...rest }) => rest),
  };
}
