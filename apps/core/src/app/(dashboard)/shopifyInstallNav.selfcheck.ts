/**
 * Install control must target /api/shopify/auth with shop + customer_id (full navigation).
 * Run: npx tsx src/app/\(dashboard\)/shopifyInstallNav.selfcheck.ts
 */
import assert from "node:assert/strict";
import {
  buildShopifyInstallAuthUrl,
  normalizeInstallShopDomain,
} from "./shopifyInstallNav";

function main(): void {
  assert.equal(
    normalizeInstallShopDomain("https://Demo-Shop.myshopify.com/"),
    "demo-shop.myshopify.com",
  );

  const href = buildShopifyInstallAuthUrl(
    "http://localhost:3100",
    "https://Demo-Shop.myshopify.com/",
    1632,
  );
  const url = new URL(href);
  assert.equal(url.origin, "http://localhost:3100");
  assert.equal(url.pathname, "/api/shopify/auth");
  assert.equal(url.searchParams.get("shop"), "demo-shop.myshopify.com");
  assert.equal(url.searchParams.get("customer_id"), "1632");

  assert.throws(
    () => buildShopifyInstallAuthUrl("http://localhost:3100", "", 1632),
    /shop domain/i,
  );
  assert.throws(
    () =>
      buildShopifyInstallAuthUrl(
        "http://localhost:3100",
        "demo.myshopify.com",
        0,
      ),
    /customer/i,
  );

  console.log("shopifyInstallNav.selfcheck ok");
}

main();
