import type {
  CommerceChannel,
  CreateProductInput,
  CreateProductResult,
  DeleteProductInput,
  InventoryUpdateInput,
  NormalizedChannelOrder,
  PriceUpdateInput,
  UpdateProductInput,
  UpdateProductResult,
  WebhookVerificationInput,
} from "@devjewels-channels/core/channels/types";
import {
  InventorySkipError,
  notImplemented,
} from "@devjewels-channels/core/channels/types";
import { resolveShopifyCredentials } from "../../core/src/security/secrets";
import { safeErrorMessage } from "../../core/src/security/redact";
import { createShopifyClient, ShopifyRateLimitError } from "./client";
import { setShopifyInventoryLevel } from "./inventory";
import { getShopifyMetaStore } from "./meta";
import {
  createShopifyProduct,
  deleteShopifyProduct,
  updateShopifyProduct,
} from "./products";
import { normalizeShopifyOrder } from "./orders";
import {
  headerValue,
  verifyShopifyWebhookHmac,
} from "./webhooks";

export { ShopifyRateLimitError, ShopifyHttpError } from "./client";

/**
 * Shopify CommerceChannel — inventory + catalog create/update/delete + order webhooks.
 */
export const shopifyAdapter: CommerceChannel = {
  platform: "SHOPIFY",

  async createProduct(input: CreateProductInput): Promise<CreateProductResult> {
    const secretRef = input.credentialsSecretRef?.trim();
    if (!secretRef) {
      throw new InventorySkipError(
        "missing_credentials_ref",
        "credentialsSecretRef required for createProduct",
      );
    }

    const meta = getShopifyMetaStore();
    const shop = await meta.getShop(input.connectionId);
    const credentials = await resolveShopifyCredentials(
      secretRef,
      shop?.shop_domain,
    );
    const client = createShopifyClient({
      shopDomain: credentials.shopDomain,
      accessToken: credentials.accessToken,
    });

    console.info("shopify_product_create_start", {
      connectionId: input.connectionId,
      designNo: input.designNo,
      variantCount: input.variants.length,
      shopDomain: credentials.shopDomain,
    });

    const created = await createShopifyProduct(client, input);

    console.info("shopify_product_create_ok", {
      connectionId: input.connectionId,
      designNo: input.designNo,
      externalProductId: created.externalProductId,
      variantCount: created.variants.length,
    });

    return created;
  },

  async updateProduct(input: UpdateProductInput): Promise<UpdateProductResult> {
    const secretRef = input.credentialsSecretRef?.trim();
    if (!secretRef) {
      throw new InventorySkipError(
        "missing_credentials_ref",
        "credentialsSecretRef required for updateProduct",
      );
    }

    const meta = getShopifyMetaStore();
    const shop = await meta.getShop(input.connectionId);
    const credentials = await resolveShopifyCredentials(
      secretRef,
      shop?.shop_domain,
    );
    const client = createShopifyClient({
      shopDomain: credentials.shopDomain,
      accessToken: credentials.accessToken,
    });

    console.info("shopify_product_update_start", {
      connectionId: input.connectionId,
      designNo: input.designNo,
      externalProductId: input.externalProductId,
      variantCount: input.variants.length,
      shopDomain: credentials.shopDomain,
    });

    const updated = await updateShopifyProduct(client, input);

    console.info("shopify_product_update_ok", {
      connectionId: input.connectionId,
      designNo: input.designNo,
      externalProductId: updated.externalProductId,
      variantCount: updated.variants.length,
    });

    return updated;
  },

  async deleteProduct(input: DeleteProductInput): Promise<void> {
    const secretRef = input.credentialsSecretRef?.trim();
    if (!secretRef) {
      throw new InventorySkipError(
        "missing_credentials_ref",
        "credentialsSecretRef required for deleteProduct",
      );
    }
    const meta = getShopifyMetaStore();
    const shop = await meta.getShop(input.connectionId);
    const credentials = await resolveShopifyCredentials(
      secretRef,
      shop?.shop_domain,
    );
    const client = createShopifyClient({
      shopDomain: credentials.shopDomain,
      accessToken: credentials.accessToken,
    });
    console.info("shopify_product_delete_start", {
      connectionId: input.connectionId,
      designNo: input.designNo,
      externalProductId: input.externalProductId,
    });
    await deleteShopifyProduct(client, input.externalProductId);
    console.info("shopify_product_delete_ok", {
      connectionId: input.connectionId,
      designNo: input.designNo,
      externalProductId: input.externalProductId,
    });
  },

  async updateInventory(input: InventoryUpdateInput): Promise<void> {
    if (input.connectionId === "_skeleton") {
      throw new InventorySkipError("skeleton", "Skeleton inventory job — no Shopify call");
    }

    const secretRef = input.credentialsSecretRef?.trim();
    if (!secretRef) {
      throw new InventorySkipError("missing_credentials_ref");
    }

    const inventoryItemId = input.externalInventoryItemId?.trim();
    if (!inventoryItemId) {
      throw new InventorySkipError(
        "missing_mapping",
        "variant_mapping.external_inventory_item_id required",
      );
    }

    const meta = getShopifyMetaStore();
    const shop = await meta.getShop(input.connectionId);
    const locationId =
      input.externalLocationId?.trim() ||
      input.locationHint?.trim() ||
      (await meta.getPrimaryLocation(input.connectionId))?.external_location_id;

    if (!locationId) {
      throw new InventorySkipError(
        "missing_location",
        "shopify_location row (or locationHint) required",
      );
    }

    const credentials = await resolveShopifyCredentials(
      secretRef,
      shop?.shop_domain,
    );

    const client = createShopifyClient({
      shopDomain: credentials.shopDomain,
      accessToken: credentials.accessToken,
    });

    console.info("shopify_inventory_update_start", {
      connectionId: input.connectionId,
      designNo: input.designNo,
      jobNo: input.jobNo,
      shopDomain: credentials.shopDomain,
      quantity: input.quantity,
    });

    try {
      await setShopifyInventoryLevel(client, {
        inventoryItemId,
        locationId,
        available: input.quantity,
      });
    } catch (err) {
      if (err instanceof ShopifyRateLimitError) {
        console.warn("shopify_inventory_rate_limited", {
          connectionId: input.connectionId,
          designNo: input.designNo,
          jobNo: input.jobNo,
          retryAfterMs: err.retryAfterMs,
        });
      } else {
        console.error("shopify_inventory_update_failed", {
          connectionId: input.connectionId,
          designNo: input.designNo,
          jobNo: input.jobNo,
          error: safeErrorMessage(err),
        });
      }
      throw err;
    }

    console.info("shopify_inventory_update_ok", {
      connectionId: input.connectionId,
      designNo: input.designNo,
      jobNo: input.jobNo,
      quantity: input.quantity,
    });
  },

  async updatePrice(input: PriceUpdateInput): Promise<void> {
    console.warn("shopify_update_price_unused", {
      connectionId: input.connectionId,
      designNo: input.designNo,
      jobNo: input.jobNo,
      hint: "use product.sync / updateProduct instead",
    });
    return notImplemented("SHOPIFY", "updatePrice");
  },

  async verifyWebhook(input: WebhookVerificationInput): Promise<void> {
    const hmacHeader =
      headerValue(input.headers, "x-shopify-hmac-sha256") ||
      headerValue(input.headers, "X-Shopify-Hmac-Sha256");
    const secret = (process.env.CHANNELS_SHOPIFY_WEBHOOK_SECRET || "").trim();
    if (!secret) {
      throw new Error("Shopify webhook secret is not configured");
    }
    const ok = verifyShopifyWebhookHmac({
      rawBody: input.rawBody,
      hmacHeader,
      secret,
    });
    if (!ok) {
      throw new Error("Invalid Shopify webhook HMAC");
    }
  },

  async handleOrder(
    payload: unknown,
    connectionId: string,
  ): Promise<NormalizedChannelOrder> {
    return normalizeShopifyOrder(payload, connectionId);
  },
};

export const shopifyChannel = shopifyAdapter;

export default shopifyAdapter;
