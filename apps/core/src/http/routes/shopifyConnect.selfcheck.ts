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
import { getConnectShopify } from "./shopifyConnect";
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
  const store = createMemoryShopifyInviteStore();
  setShopifyInviteStoreForTests(store);
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
  const res = await getConnectShopify(
    new Request(
      `https://channels.devjewels.com/api/connect/shopify?token=${encodeURIComponent(token)}`,
    ),
  );
  assert.equal(res.status, 302);
  const loc = new URL(locationOf(res));
  assert.equal(loc.pathname, "/api/shopify/auth");
  assert.equal(loc.searchParams.get("shop"), "buffedandbubbly.myshopify.com");
  assert.equal(loc.searchParams.get("customer_id"), "907");
  assert.equal(loc.searchParams.get("merchant"), "1");
  setShopifyInviteStoreForTests(null);
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
  const res = await getConnectShopify(
    new Request(
      `https://channels.devjewels.com/api/connect/shopify?token=${encodeURIComponent(token)}`,
    ),
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
  const res = await getConnectShopify(
    new Request(
      `https://channels.devjewels.com/api/connect/shopify?token=${encodeURIComponent(token)}`,
    ),
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

async function main(): Promise<void> {
  await testMissingTokenRedirectsAbsolute();
  await testGarbageTokenRedirects();
  await testValidInviteRedirectsToOauth();
  await testUsedInviteRedirects();
  await testConsumeThrowRedirects();
  await testConnectSuccessHtml();
  console.log("shopifyConnect self-check ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
