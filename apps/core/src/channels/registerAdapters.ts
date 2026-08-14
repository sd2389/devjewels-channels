/**
 * Registers platform adapters into AdapterRouter.
 * Relative imports avoid circular workspace package deps during scaffold.
 * Idempotent — safe to call from API routes, workers, and import jobs.
 */
import { AdapterRouter } from "./router";
import { shopifyAdapter } from "../../../shopify/src/adapter";
import { woocommerceAdapter } from "../../../woocommerce/src/adapter";

export function registerDefaultAdapters(): void {
  try {
    AdapterRouter.get("SHOPIFY");
    AdapterRouter.get("WOOCOMMERCE");
    return;
  } catch {
    AdapterRouter.register(shopifyAdapter);
    AdapterRouter.register(woocommerceAdapter);
  }
}
