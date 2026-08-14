/**
 * Minimal check: vault write + ref format (no Shopify/network).
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  writeVaultSecret,
  readVaultSecret,
  tryReadVaultSecret,
  resolveVaultRoot,
} from "./vault";
import {
  getShopifyOAuthConfig,
  saveShopifyOAuthAppCredentials,
  SHOPIFY_OAUTH_APP_VAULT_ID,
} from "@devjewels-channels/shopify/auth";

async function main() {
  const savedVaultDir = process.env.CHANNELS_VAULT_DIR;
  delete process.env.CHANNELS_VAULT_DIR;
  const defaultRoot = resolveVaultRoot().replace(/\\/g, "/");
  assert.match(defaultRoot, /\.data\/secrets$/);
  assert.equal(defaultRoot.includes("apps/core/.data"), false);
  if (savedVaultDir) process.env.CHANNELS_VAULT_DIR = savedVaultDir;

  const dir = path.join(process.cwd(), ".data", "secrets-selfcheck");
  process.env.CHANNELS_VAULT_DIR = dir;
  const ref = await writeVaultSecret({
    accessToken: "shpat_test",
    shopDomain: "demo.myshopify.com",
  });
  assert.match(ref, /^vault:[0-9a-f-]{36}$/i);
  const raw = await readVaultSecret(ref.slice("vault:".length));
  const parsed = JSON.parse(raw) as { accessToken: string };
  assert.equal(parsed.accessToken, "shpat_test");

  const stable = await writeVaultSecret(
    { apiKey: "k1", apiSecret: "s1" },
    "shopify-oauth-app",
  );
  assert.equal(stable, "vault:shopify-oauth-app");
  const again = await writeVaultSecret(
    { apiKey: "k2", apiSecret: "s2" },
    "shopify-oauth-app",
  );
  assert.equal(again, "vault:shopify-oauth-app");
  const overwritten = JSON.parse(await readVaultSecret("shopify-oauth-app")) as {
    apiKey: string;
  };
  assert.equal(overwritten.apiKey, "k2");
  assert.equal(await tryReadVaultSecret("missing-id"), null);

  const savedKey = process.env.SHOPIFY_API_KEY;
  const savedSecret = process.env.SHOPIFY_API_SECRET;
  delete process.env.SHOPIFY_API_KEY;
  delete process.env.SHOPIFY_API_SECRET;
  await saveShopifyOAuthAppCredentials({
    apiKey: "vault_key_abcd",
    apiSecret: "vault_secret_selfcheck",
  });
  const resolved = await getShopifyOAuthConfig();
  assert.equal(resolved.apiKey, "vault_key_abcd");
  if (savedKey !== undefined) process.env.SHOPIFY_API_KEY = savedKey;
  else delete process.env.SHOPIFY_API_KEY;
  if (savedSecret !== undefined) process.env.SHOPIFY_API_SECRET = savedSecret;
  else delete process.env.SHOPIFY_API_SECRET;
  assert.equal(SHOPIFY_OAUTH_APP_VAULT_ID, "shopify-oauth-app");

  await fs.rm(dir, { recursive: true, force: true });
  console.log("vault.selfcheck: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
