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
} from "./vault";

async function main() {
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

  await fs.rm(dir, { recursive: true, force: true });
  console.log("vault.selfcheck: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
