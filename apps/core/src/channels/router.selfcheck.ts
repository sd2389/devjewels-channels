import { AdapterRouter, resetAdaptersForTests } from "./router";
import type { CommerceChannel } from "./types";
import { notImplemented } from "./types";

const stub: CommerceChannel = {
  platform: "SHOPIFY",
  createProduct: () => notImplemented("SHOPIFY", "createProduct"),
  updateProduct: () => notImplemented("SHOPIFY", "updateProduct"),
  updateInventory: async () => {},
  updatePrice: async () => {},
  verifyWebhook: () => notImplemented("SHOPIFY", "verifyWebhook"),
  handleOrder: () => notImplemented("SHOPIFY", "handleOrder"),
};

resetAdaptersForTests();
AdapterRouter.register(stub);
const got = AdapterRouter.get("SHOPIFY");
if (got.platform !== "SHOPIFY") throw new Error("AdapterRouter self-check failed");
console.log("AdapterRouter self-check ok");
