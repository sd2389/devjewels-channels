/**
 * GET /api/connect/shopify must 302 on bad invites — never 500.
 * Node Response.redirect() throws TypeError on relative URLs (production 500).
 * Run: npm run selfcheck:shopify-connect -w @devjewels-channels/core
 */
import assert from "node:assert/strict";
import {
  createInviteJti,
  signShopifyInviteToken,
} from "@devjewels-channels/shopify/shopifyInvite";
import {
  createMemoryShopifyInviteStore,
  setShopifyInviteStoreForTests,
} from "@devjewels-channels/shopify/inviteStore";
import {
  createMemoryShopifyMetaStore,
  setShopifyMetaStoreForTests,
} from "@devjewels-channels/shopify";
import { getConnectShopify, postConnectShopify } from "./shopifyConnect";
import { dispatch } from "../router";

process.env.CHANNELS_INVITE_SIGNING_SECRET = "selfcheck-invite-secret";

function locationOf(res: Response): string {
  return res.headers.get("location") || "";
}

async function testMissingTokenRedirectsAbsolute(): Promise<void> {
  const res = await getConnectShopify(
    new Request("https://channels.devjewels.com/api/connect/shopify"),
  );
  assert.equal(res.status, 302, "missing token must not 500");
  const loc = locationOf(res);
  assert.equal(
    loc,
    "https://channels.devjewels.com/connect/success?shopify_error=invalid_invite",
  );
}

async function testGarbageTokenRedirects(): Promise<void> {
  const res = await getConnectShopify(
    new Request(
      "https://channels.devjewels.com/api/connect/shopify?token=not-a-valid-token",
    ),
  );
  assert.equal(res.status, 302);
  assert.match(locationOf(res), /shopify_error=invalid_invite/);
}

async function testValidInviteRedirectsToOauth(): Promise<void> {
  const prev = {
    key: process.env.SHOPIFY_API_KEY,
    secret: process.env.SHOPIFY_API_SECRET,
    pubKey: process.env.SHOPIFY_PUBLIC_API_KEY,
    pubSecret: process.env.SHOPIFY_PUBLIC_API_SECRET,
    vault: process.env.CHANNELS_VAULT_DIR,
  };
  process.env.SHOPIFY_API_KEY = "custom_key_e421";
  process.env.SHOPIFY_API_SECRET = "custom_secret";
  process.env.SHOPIFY_PUBLIC_API_KEY = "4238185738d48848640cb7bf46362437";
  process.env.SHOPIFY_PUBLIC_API_SECRET = "public_secret";
  process.env.CHANNELS_PUBLIC_BASE_URL = "https://channels.devjewels.com";
  delete process.env.CHANNELS_VAULT_DIR;

  const store = createMemoryShopifyInviteStore();
  setShopifyInviteStoreForTests(store);
  setShopifyMetaStoreForTests(createMemoryShopifyMetaStore());
  const jti = createInviteJti();
  const expiresAt = new Date(Date.now() + 60_000);
  await store.createInvite({
    jti,
    customerId: 907,
    shopDomain: "buffedandbubbly.myshopify.com",
    expiresAt,
  });
  const token = signShopifyInviteToken({
    customerId: 907,
    shop: "buffedandbubbly.myshopify.com",
    jti,
    expiresAt,
  });
  const page = await getConnectShopify(
    new Request(
      `https://channels.devjewels.com/api/connect/shopify?token=${encodeURIComponent(token)}`,
    ),
  );
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Continue to Shopify/);
  assert.equal(store.rows.get(jti)?.consumed_at, null, "GET must not consume the invite");

  const res = await postConnectShopify(
    new Request("https://channels.devjewels.com/api/connect/shopify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    }),
  );
  assert.equal(res.status, 302);
  const loc = new URL(locationOf(res));
  assert.equal(loc.pathname, "/api/shopify/auth");
  assert.equal(loc.searchParams.get("shop"), "buffedandbubbly.myshopify.com");
  assert.equal(loc.searchParams.get("customer_id"), "907");
  assert.equal(loc.searchParams.get("merchant"), "1");
  // Must prefer Public app — never Custom BuffedBubbly for merchant invites.
  assert.equal(
    loc.searchParams.get("client_id"),
    "4238185738d48848640cb7bf46362437",
  );
  setShopifyInviteStoreForTests(null);
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
  if (prev.vault !== undefined) process.env.CHANNELS_VAULT_DIR = prev.vault;
  else delete process.env.CHANNELS_VAULT_DIR;
}

async function testUsedInviteRedirects(): Promise<void> {
  const store = createMemoryShopifyInviteStore();
  setShopifyInviteStoreForTests(store);
  const jti = createInviteJti();
  const expiresAt = new Date(Date.now() + 60_000);
  const token = signShopifyInviteToken({
    customerId: 1,
    shop: "store.myshopify.com",
    jti,
    expiresAt,
  });
  const res = await postConnectShopify(
    new Request("https://channels.devjewels.com/api/connect/shopify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    }),
  );
  assert.equal(res.status, 302);
  assert.match(locationOf(res), /shopify_error=invite_used/);
  setShopifyInviteStoreForTests(null);
}

async function testConsumeThrowRedirects(): Promise<void> {
  setShopifyInviteStoreForTests({
    async createInvite() {},
    async consumeInvite() {
      throw new Error("relation \"shopify_connect_invite\" does not exist");
    },
    async findPendingByShopDomain() {
      return null;
    },
  });
  const jti = createInviteJti();
  const expiresAt = new Date(Date.now() + 60_000);
  const token = signShopifyInviteToken({
    customerId: 1,
    shop: "store.myshopify.com",
    jti,
    expiresAt,
  });
  const res = await postConnectShopify(
    new Request("https://channels.devjewels.com/api/connect/shopify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    }),
  );
  assert.equal(res.status, 302, "DB errors must not 500 the merchant");
  assert.match(locationOf(res), /shopify_error=invalid_invite/);
  setShopifyInviteStoreForTests(null);
}

async function testConnectSuccessHtml(): Promise<void> {
  const res = await dispatch(
    new Request(
      "https://channels.devjewels.com/connect/success?shopify_error=invalid_invite",
    ),
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/html/);
  const body = await res.text();
  assert.match(body, /invalid or has expired/i);
}

async function testPostRouteIsRegistered(): Promise<void> {
  const routed = await dispatch(
    new Request("https://channels.devjewels.com/api/connect/shopify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "not-a-valid-token" }).toString(),
    }),
  );
  assert.equal(routed.status, 302);
  assert.match(locationOf(routed), /shopify_error=invalid_invite/);
}

async function main(): Promise<void> {
  await testMissingTokenRedirectsAbsolute();
  await testGarbageTokenRedirects();
  await testValidInviteRedirectsToOauth();
  await testUsedInviteRedirects();
  await testConsumeThrowRedirects();
  await testConnectSuccessHtml();
  await testPostRouteIsRegistered();
  console.log("shopifyConnect self-check ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
