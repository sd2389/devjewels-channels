/**
 * Registers platform adapters into AdapterRouter.
 * Relative imports avoid circular workspace package deps during scaffold.
 */
import { AdapterRouter } from "./router";
import { shopifyAdapter } from "../../../shopify/src/adapter";
import { woocommerceAdapter } from "../../../woocommerce/src/adapter";

export function registerDefaultAdapters(): void {
  AdapterRouter.register(shopifyAdapter);
  AdapterRouter.register(woocommerceAdapter);
}
