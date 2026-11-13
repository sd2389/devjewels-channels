/** Commerce platform discriminator — stored on shared `connection.platform`. */
export type ChannelPlatform = "SHOPIFY" | "WOOCOMMERCE" | "MAGENTO";

/** Sellable unit in Dev Jewels SoT: design + live stock job. */
export type DesignJobKey = {
  designNo: string;
  jobNo: string;
};

/** Merchant-visible job details (Shopify variant metafields only). */
export type ChannelJobVariantDetails = {
  store?: string;
  category?: string;
  metal?: string;
  purity?: string;
  color?: string;
  diaQly?: string;
  diaClr?: string;
  /** Lab Grown / Natural — same label as the customer stock table Type column. */
  diamondType?: string;
  size?: string;
  gwt?: string;
  nwt?: string;
  dwt?: string;
  /** Design stone weight (customer stock table Stone WT). */
  swt?: string;
  certificate?: string;
};

export type InventoryUpdateInput = DesignJobKey & {
  connectionId: string;
  quantity: number;
  /**
   * DevJewels wholesale / unit cost for Shopify inventoryItem.cost.
   * Never the storefront selling price. Omit to leave cost unchanged.
   */
  unitCost?: number;
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
  /**
   * Persist external product id as soon as the platform shell exists
   * (before variants/media). Prevents orphan duplicates on retry.
   */
  onExternalProductId?: (externalProductId: string) => Promise<void>;
  /**
   * Merchant owns storefront copy by default. When false (the default) the
   * adapter may only reconcile the live-stock variant set + quantity + unit
   * cost; titles, descriptions, selling prices, tags, images, product status
   * and merchant-made options must not be written.
   */
  syncProductContent?: boolean;
  /**
   * Write the live stock table into the description and nothing else of the
   * product's content (title, images, price, status stay the merchant's).
   */
  syncProductDescription?: boolean;
  /** Variants keyed by job_no for mapping. */
  variants: Array<{
    jobNo: string;
    sku?: string;
    price: number;
    /** DevJewels wholesale cost for inventoryItem.cost. Never the selling price. */
    wholesaleCost?: number;
    quantity: number;
    /** Live stock attributes for Shopify variant metafields. */
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
  /**
   * Variants to remove (OOS design_no placeholder after live stock arrives,
   * or sold jobs no longer in the Customer API inventory feed).
   */
  removeVariants?: Array<{
    jobNo: string;
    externalVariantId: string;
    externalInventoryItemId?: string;
  }>;
};

export type UpdateProductResult = CreateProductResult;

/** One live piece placed in a Metal × Size slot. */
export type ChannelSlotPiece = {
  jobNo: string;
  /** Customer-facing price after Channels markup. */
  price: number;
  /** DevJewels wholesale cost for inventoryItem.cost. Never the selling price. */
  wholesaleCost?: number;
  details?: ChannelJobVariantDetails;
};

/** One Metal × Size variant. Its first piece is the one an order takes. */
export type ChannelVariantSlot = {
  /** Stable identity: lower-cased "metal|size". */
  key: string;
  metal: string;
  /** Absent when the design has no Size option. */
  size?: string;
  /** Stable SKU — never a job number. */
  sku: string;
  /** Live pieces of the combination, cheapest first. */
  pieces: ChannelSlotPiece[];
  quantity: number;
  /** Price for a new variant (an existing one keeps the merchant's price). */
  price: number;
};

export type ChannelMetalSizePlan = {
  metalValues: string[];
  /** Empty means no Size option. */
  sizeValues: string[];
  slots: ChannelVariantSlot[];
  /** Pieces with no metal data — reported, never guessed into a slot. */
  unplaced: string[];
};

export type SyncMetalSizeVariantsInput = Omit<CreateProductInput, "variants"> & {
  /** Mapped product, if any. Absent → reclaim by design tag, else create. */
  externalProductId?: string;
  plan: ChannelMetalSizePlan;
  /** Write inventoryItem.cost from each slot's backing piece. */
  includeCost: boolean;
  /** Write slot quantities (connection.sync_inventory, or zeroing after a revoke). */
  writeInventory: boolean;
};

export type SyncMetalSizeVariantsResult = {
  externalProductId: string;
  slots: Array<{
    key: string;
    sku: string;
    externalVariantId: string;
    externalInventoryItemId?: string;
    jobNos: string[];
  }>;
};

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

  /**
   * Metal × Size layout: make the product's options, variants, quantities and
   * details match `plan` in one pass. Optional — platforms without it keep the
   * piece layout.
   */
  syncMetalSizeVariants?(input: SyncMetalSizeVariantsInput): Promise<SyncMetalSizeVariantsResult>;

  updatePrice(input: PriceUpdateInput): Promise<void>;

  /** Verify platform signature; throw on failure. */
  verifyWebhook(input: WebhookVerificationInput): Promise<void>;

  /** Parse verified payload into a normalized order for Django reserve. */
  handleOrder(payload: unknown, connectionId: string): Promise<NormalizedChannelOrder>;

  /**
   * One-time, idempotent store setup so the channel can display what we sync
   * (Shopify: variant metafield definitions with storefront access).
   * Best effort — never throws, never blocks a connect or an import.
   */
  ensureChannelMetadata?(input: {
    connectionId: string;
    credentialsSecretRef?: string;
  }): Promise<void>;
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
