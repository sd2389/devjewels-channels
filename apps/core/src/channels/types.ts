/** Commerce platform discriminator — stored on shared `connection.platform`. */
export type ChannelPlatform = "SHOPIFY" | "WOOCOMMERCE" | "MAGENTO";

/** Sellable unit in Dev Jewels SoT: design + live stock job. */
export type DesignJobKey = {
  designNo: string;
  jobNo: string;
};

/** Merchant-visible job details (Shopify variant metafields / description). */
export type ChannelJobVariantDetails = {
  store?: string;
  category?: string;
  metal?: string;
  purity?: string;
  color?: string;
  diaQly?: string;
  diaClr?: string;
  size?: string;
  gwt?: string;
  nwt?: string;
  dwt?: string;
};

export type InventoryUpdateInput = DesignJobKey & {
  connectionId: string;
  quantity: number;
  /** Optional external location / warehouse hint (platform-specific). */
  locationHint?: string;
  /** Resolved from variant_mapping before adapter call when available. */
  externalInventoryItemId?: string;
  /** Resolved from platform location tables when available. */
  externalLocationId?: string;
  /** Secret ref from connection.credentials_secret_ref (never a raw token). */
  credentialsSecretRef?: string;
};

/** Non-retryable skip (missing mapping, disabled connection, etc.). */
export class InventorySkipError extends Error {
  readonly reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = "InventorySkipError";
    this.reason = reason;
  }
}

export type PriceUpdateInput = DesignJobKey & {
  connectionId: string;
  /** Customer-facing price after Channels markup (already computed upstream). */
  price: number;
  currency: string;
};

export type CreateProductInput = {
  connectionId: string;
  designNo: string;
  title: string;
  /** Secret ref from connection.credentials_secret_ref (never a raw token). */
  credentialsSecretRef?: string;
  /** Public HTTPS image URLs Shopify can fetch (CDN). */
  imageUrls?: string[];
  /** Shopify Product type — DevJewels design.category. */
  productType?: string;
  /** Shopify tags — collection / subcategory / producttype. */
  tags?: string[];
  /** Variants keyed by job_no for mapping. */
  variants: Array<{
    jobNo: string;
    sku?: string;
    price: number;
    quantity: number;
    /** Live stock attributes for Shopify metafields / description. */
    details?: ChannelJobVariantDetails;
  }>;
};

export type CreateProductResult = {
  externalProductId: string;
  variants: Array<{
    jobNo: string;
    externalVariantId: string;
    externalInventoryItemId?: string;
  }>;
};

/** Update an already-mapped Shopify (or other) product. */
export type UpdateProductInput = CreateProductInput & {
  externalProductId: string;
  /** Existing variant mappings (job_no → external ids). Missing jobs are created. */
  existingVariants?: Array<{
    jobNo: string;
    externalVariantId: string;
    externalInventoryItemId?: string;
  }>;
};

export type UpdateProductResult = CreateProductResult;

export type DeleteProductInput = {
  connectionId: string;
  designNo: string;
  externalProductId: string;
  credentialsSecretRef?: string;
};

export type NormalizedChannelOrderLine = DesignJobKey & {
  quantity: number;
  externalLineId?: string;
};

/** Platform-agnostic order shape before Django reserve. */
export type NormalizedChannelOrder = {
  connectionId: string;
  platform: ChannelPlatform;
  externalOrderId: string;
  currency: string;
  lines: NormalizedChannelOrderLine[];
  customerEmail?: string;
  rawPayloadRef?: string;
};

export type WebhookVerificationInput = {
  connectionId?: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string | Buffer;
};

/**
 * Every commerce platform implements this contract.
 * Services/workers call the interface; they never import Shopify/Woo SDKs.
 */
export interface CommerceChannel {
  readonly platform: ChannelPlatform;

  createProduct(input: CreateProductInput): Promise<CreateProductResult>;

  updateProduct(input: UpdateProductInput): Promise<UpdateProductResult>;

  /** Remove channel product when entitlement revoked (nothing left for that design). */
  deleteProduct(input: DeleteProductInput): Promise<void>;

  updateInventory(input: InventoryUpdateInput): Promise<void>;

  updatePrice(input: PriceUpdateInput): Promise<void>;

  /** Verify platform signature; throw on failure. */
  verifyWebhook(input: WebhookVerificationInput): Promise<void>;

  /** Parse verified payload into a normalized order for Django reserve. */
  handleOrder(payload: unknown, connectionId: string): Promise<NormalizedChannelOrder>;
}

export class NotImplementedError extends Error {
  constructor(platform: ChannelPlatform, method: string) {
    super(`${platform}.${method} is not implemented yet`);
    this.name = "NotImplementedError";
  }
}

export function notImplemented(
  platform: ChannelPlatform,
  method: string,
): never {
  throw new NotImplementedError(platform, method);
}
