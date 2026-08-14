/**
 * Compliance webhook HMAC + shop redact ack (no network).
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyShopifyWebhookHmac } from "../../../shopify/src/webhooks";
import {
  handleShopifyShopRedact,
  isShopifyComplianceTopic,
} from "./shopifyCompliance";
import { createMemoryShopifyMetaStore, setShopifyMetaStoreForTests } from "../../../shopify/src/meta";
import {
  createMemoryConnectionStore,
  setConnectionStoreForTests,
} from "./connections";

async function main() {
  assert.equal(isShopifyComplianceTopic("shop/redact"), true);
  assert.equal(isShopifyComplianceTopic("orders/create"), false);

  const secret = "test_api_secret";
  const body = JSON.stringify({ shop_domain: "demo.myshopify.com", shop_id: 1 });
  const hmac = createHmac("sha256", secret).update(body).digest("base64");
  assert.equal(
    verifyShopifyWebhookHmac({ rawBody: body, hmacHeader: hmac, secret }),
    true,
  );
  assert.equal(
    verifyShopifyWebhookHmac({
      rawBody: body,
      hmacHeader: "bad",
      secret,
    }),
    false,
  );

  setConnectionStoreForTests(
    createMemoryConnectionStore([
      {
        id: "conn-1",
        platform: "SHOPIFY",
        name: "Demo",
        is_active: true,
        credentials_secret_ref: "vault:x",
        markup_bps: 0,
        markup_mode: "none",
        markup_value: 0,
        customer_id: 1,
        sync_inventory: true,
        sync_price: false,
        sync_orders: false,
        sync_products: true,
      },
    ]),
  );
  setShopifyMetaStoreForTests(
    createMemoryShopifyMetaStore({
      shops: [{ connection_id: "conn-1", shop_domain: "demo.myshopify.com" }],
    }),
  );

  const result = await handleShopifyShopRedact("demo.myshopify.com");
  assert.equal(result.connectionId, "conn-1");
  assert.equal(result.deactivated, true);

  const unknown = await handleShopifyShopRedact("other.myshopify.com");
  assert.equal(unknown.connectionId, null);

  setConnectionStoreForTests(null);
  setShopifyMetaStoreForTests(null);

  console.log("shopifyCompliance.selfcheck: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
