/**
 * Shopify OAuth start route: missing shop → 400; missing credentials → 503 dashboard message.
 * Run: npm run selfcheck:shopify-auth-route -w @devjewels-channels/core
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  SHOPIFY_OAUTH_NOT_CONFIGURED_MESSAGE,
} from "@devjewels-channels/shopify/auth";
import { GET } from "./route";

async function jsonError(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "";
}

async function main(): Promise<void> {
  const missingShop = await GET(
    new NextRequest("http://localhost:3100/api/shopify/auth?customer_id=1632"),
  );
  assert.equal(missingShop.status, 400);
  assert.match(await jsonError(missingShop), /Missing shop/i);

  const missingCustomer = await GET(
    new NextRequest(
      "http://localhost:3100/api/shopify/auth?shop=demo.myshopify.com",
    ),
  );
  assert.equal(missingCustomer.status, 400);
  assert.match(await jsonError(missingCustomer), /customer_id/i);

  const emptyVault = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-route-selfcheck-"));
  const prevVault = process.env.CHANNELS_VAULT_DIR;
  const prevKey = process.env.SHOPIFY_API_KEY;
  const prevSecret = process.env.SHOPIFY_API_SECRET;
  process.env.CHANNELS_VAULT_DIR = emptyVault;
  delete process.env.SHOPIFY_API_KEY;
  delete process.env.SHOPIFY_API_SECRET;

  try {
    const missingCreds = await GET(
      new NextRequest(
        "http://localhost:3100/api/shopify/auth?shop=demo.myshopify.com&customer_id=1632",
      ),
    );
    assert.equal(missingCreds.status, 503);
    assert.equal(await jsonError(missingCreds), SHOPIFY_OAUTH_NOT_CONFIGURED_MESSAGE);
  } finally {
    if (prevVault !== undefined) process.env.CHANNELS_VAULT_DIR = prevVault;
    else delete process.env.CHANNELS_VAULT_DIR;
    if (prevKey !== undefined) process.env.SHOPIFY_API_KEY = prevKey;
    else delete process.env.SHOPIFY_API_KEY;
    if (prevSecret !== undefined) process.env.SHOPIFY_API_SECRET = prevSecret;
    else delete process.env.SHOPIFY_API_SECRET;
    await fs.rm(emptyVault, { recursive: true, force: true });
  }

  console.log("shopify auth route.selfcheck ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
