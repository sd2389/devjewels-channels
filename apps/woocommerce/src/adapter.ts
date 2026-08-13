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
import { notImplemented } from "@devjewels-channels/core/channels/types";

/** Phase 3 stub — notImplemented until WooCommerce work starts. */
export const woocommerceAdapter: CommerceChannel = {
  platform: "WOOCOMMERCE",

  async createProduct(_input: CreateProductInput): Promise<CreateProductResult> {
    return notImplemented("WOOCOMMERCE", "createProduct");
  },

  async updateProduct(_input: UpdateProductInput): Promise<UpdateProductResult> {
    return notImplemented("WOOCOMMERCE", "updateProduct");
  },

  async deleteProduct(_input: DeleteProductInput): Promise<void> {
    return notImplemented("WOOCOMMERCE", "deleteProduct");
  },

  async updateInventory(_input: InventoryUpdateInput): Promise<void> {
    return notImplemented("WOOCOMMERCE", "updateInventory");
  },

  async updatePrice(_input: PriceUpdateInput): Promise<void> {
    return notImplemented("WOOCOMMERCE", "updatePrice");
  },

  async verifyWebhook(_input: WebhookVerificationInput): Promise<void> {
    return notImplemented("WOOCOMMERCE", "verifyWebhook");
  },

  async handleOrder(
    _payload: unknown,
    _connectionId: string,
  ): Promise<NormalizedChannelOrder> {
    return notImplemented("WOOCOMMERCE", "handleOrder");
  },
};

export const wooCommerceChannel = woocommerceAdapter;

export default woocommerceAdapter;
