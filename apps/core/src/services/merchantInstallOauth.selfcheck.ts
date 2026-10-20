/**
 * Merchant invite OAuth must prefer Public app over Custom BuffedBubbly.
 * Run: npm run selfcheck:merchant-install-oauth -w @devjewels-channels/core
 */
import assert from "node:assert/strict";
import {
  CUSTOM_APP_ALREADY_BOUND_MESSAGE,
  resolveMerchantInstallOAuthConfig,
} from "./merchantInstallOauth";
import {
  createMemoryShopifyMetaStore,
  setShopifyMetaStoreForTests,
} from "@devjewels-channels/shopify";

async function testPrefersPublicClient(): Promise<void> {
  const prev = {
    key: process.env.SHOPIFY_API_KEY,
    secret: process.env.SHOPIFY_API_SECRET,
    pubKey: process.env.SHOPIFY_PUBLIC_API_KEY,
    pubSecret: process.env.SHOPIFY_PUBLIC_API_SECRET,
    base: process.env.CHANNELS_PUBLIC_BASE_URL,
    vault: process.env.CHANNELS_VAULT_DIR,
  };
  process.env.SHOPIFY_API_KEY = "14c46847f1da5cad190769d31491e421";
  process.env.SHOPIFY_API_SECRET = "custom_secret";
  process.env.SHOPIFY_PUBLIC_API_KEY = "4238185738d48848640cb7bf46362437";
  process.env.SHOPIFY_PUBLIC_API_SECRET = "public_secret";
  process.env.CHANNELS_PUBLIC_BASE_URL = "https://channels.devjewels.com";
  delete process.env.CHANNELS_VAULT_DIR;

  setShopifyMetaStoreForTests(createMemoryShopifyMetaStore());
  try {
    const config = await resolveMerchantInstallOAuthConfig(
      "3e6692-2.myshopify.com",
    );
    assert.equal(config.apiKey, "4238185738d48848640cb7bf46362437");
    assert.ok(CUSTOM_APP_ALREADY_BOUND_MESSAGE.includes("Public"));
  } finally {
    setShopifyMetaStoreForTests(null);
    if (prev.key !== undefined) process.env.SHOPIFY_API_KEY = prev.key;
    else delete process.env.SHOPIFY_API_KEY;
    if (prev.secret !== undefined) process.env.SHOPIFY_API_SECRET = prev.secret;
    else delete process.env.SHOPIFY_API_SECRET;
    if (prev.pubKey !== undefined) process.env.SHOPIFY_PUBLIC_API_KEY = prev.pubKey;
    else delete process.env.SHOPIFY_PUBLIC_API_KEY;
    if (prev.pubSecret !== undefined) {
      process.env.SHOPIFY_PUBLIC_API_SECRET = prev.pubSecret;
    } else delete process.env.SHOPIFY_PUBLIC_API_SECRET;
    if (prev.base !== undefined) process.env.CHANNELS_PUBLIC_BASE_URL = prev.base;
    else delete process.env.CHANNELS_PUBLIC_BASE_URL;
    if (prev.vault !== undefined) process.env.CHANNELS_VAULT_DIR = prev.vault;
    else delete process.env.CHANNELS_VAULT_DIR;
  }
}

async function main(): Promise<void> {
  await testPrefersPublicClient();
  console.log("merchantInstallOauth self-check ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
