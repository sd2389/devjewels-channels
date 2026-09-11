/**
 * GET / (Shopify application_url) must HMAC-verify, then OAuth or HTML — never JSON 404.
 * Run: npm run selfcheck:app-launch -w @devjewels-channels/core
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInviteJti } from "@devjewels-channels/shopify/shopifyInvite";
import {
  createMemoryShopifyInviteStore,
  setShopifyInviteStoreForTests,
} from "@devjewels-channels/shopify/inviteStore";
import {
  createMemoryShopifyMetaStore,
  setShopifyMetaStoreForTests,
} from "@devjewels-channels/shopify";
import { CONNECT_INSTALLED_BODY } from "../connectSuccessPage";
import { dispatch } from "../router";

process.env.CHANNELS_INVITE_SIGNING_SECRET = "selfcheck-invite-secret";

function locationOf(res: Response): string {
  return res.headers.get("location") || "";
}

function signShopifyQuery(
  params: Record<string, string>,
  secret: string,
): URLSearchParams {
  const query = new URLSearchParams(params);
  const message = [...query.entries()]
    .filter(([key]) => key !== "hmac")
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("&");
  query.set("hmac", createHmac("sha256", secret).update(message).digest("hex"));
  return query;
}

function launchUrl(query: URLSearchParams): string {
  return `https://channels.devjewels.com/?${query.toString()}`;
}

async function withOauthEnv(run: () => Promise<void>): Promise<void> {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "channels-app-launch-"));
  const prev = {
    vault: process.env.CHANNELS_VAULT_DIR,
    key: process.env.SHOPIFY_API_KEY,
    secret: process.env.SHOPIFY_API_SECRET,
  };
  process.env.CHANNELS_VAULT_DIR = vaultDir;
  process.env.SHOPIFY_API_KEY = "key_test";
  process.env.SHOPIFY_API_SECRET = "secret_test";
  const invites = createMemoryShopifyInviteStore();
  setShopifyInviteStoreForTests(invites);
  setShopifyMetaStoreForTests(createMemoryShopifyMetaStore());
  try {
    await run();
  } finally {
    setShopifyInviteStoreForTests(null);
    setShopifyMetaStoreForTests(null);
    if (prev.vault !== undefined) process.env.CHANNELS_VAULT_DIR = prev.vault;
    else delete process.env.CHANNELS_VAULT_DIR;
    if (prev.key !== undefined) process.env.SHOPIFY_API_KEY = prev.key;
    else delete process.env.SHOPIFY_API_KEY;
    if (prev.secret !== undefined) process.env.SHOPIFY_API_SECRET = prev.secret;
    else delete process.env.SHOPIFY_API_SECRET;
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
}

async function testBareRootIsHtmlNotJson404(): Promise<void> {
  const res = await dispatch(new Request("https://channels.devjewels.com/"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/html/);
  const body = await res.text();
  assert.match(body, /App installed/i);
  assert.doesNotMatch(body, /Not found/);
  assert.doesNotMatch(body, /"error"/);
}

async function testInvalidHmacIsGeneric401(): Promise<void> {
  await withOauthEnv(async () => {
    const query = signShopifyQuery(
      {
        shop: "enfakt-v6.myshopify.com",
        host: "YWRtaW4uc2hvcGlmeS5jb20",
        timestamp: "123",
      },
      "secret_test",
    );
    query.set("hmac", "deadbeef");
    const res = await dispatch(new Request(launchUrl(query)));
    assert.equal(res.status, 401);
    const body = await res.text();
    assert.equal(body, JSON.stringify({ error: "Unauthorized" }));
    assert.doesNotMatch(body, /deadbeef|secret_test|hmac|Not found|stack/i);
  });
}

async function testPendingInviteRedirectsToOauth(): Promise<void> {
  await withOauthEnv(async () => {
    const store = createMemoryShopifyInviteStore();
    setShopifyInviteStoreForTests(store);
    const jti = createInviteJti();
    await store.createInvite({
      jti,
      customerId: 907,
      shopDomain: "enfakt-v6.myshopify.com",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const query = signShopifyQuery(
      {
        shop: "enfakt-v6.myshopify.com",
        host: "YWRtaW4uc2hvcGlmeS5jb20",
        timestamp: "123",
      },
      "secret_test",
    );
    const res = await dispatch(new Request(launchUrl(query)));
    assert.equal(res.status, 302);
    const loc = new URL(locationOf(res));
    assert.equal(loc.origin, "https://channels.devjewels.com");
    assert.equal(loc.pathname, "/api/shopify/auth");
    assert.equal(loc.searchParams.get("shop"), "enfakt-v6.myshopify.com");
    assert.equal(loc.searchParams.get("customer_id"), "907");
    assert.equal(loc.searchParams.get("merchant"), "1");
    const stillPending = await store.findPendingByShopDomain(
      "enfakt-v6.myshopify.com",
    );
    assert.ok(stillPending, "app launch must not consume the invite");
  });
}

async function testInviteCustomerIdIsNotHardcoded(): Promise<void> {
  await withOauthEnv(async () => {
    const store = createMemoryShopifyInviteStore();
    setShopifyInviteStoreForTests(store);
    await store.createInvite({
      jti: createInviteJti(),
      customerId: 42,
      shopDomain: "other-shop.myshopify.com",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const query = signShopifyQuery(
      { shop: "other-shop.myshopify.com", timestamp: "123" },
      "secret_test",
    );
    const res = await dispatch(new Request(launchUrl(query)));
    assert.equal(res.status, 302);
    const loc = new URL(locationOf(res));
    assert.equal(loc.searchParams.get("customer_id"), "42");
    assert.notEqual(loc.searchParams.get("customer_id"), "907");
  });
}

async function testConnectedShopRedirectsToSuccess(): Promise<void> {
  await withOauthEnv(async () => {
    const invites = createMemoryShopifyInviteStore();
    await invites.createInvite({
      jti: createInviteJti(),
      customerId: 907,
      shopDomain: "enfakt-v6.myshopify.com",
      expiresAt: new Date(Date.now() + 60_000),
    });
    setShopifyInviteStoreForTests(invites);
    setShopifyMetaStoreForTests(
      createMemoryShopifyMetaStore({
        shops: [
          {
            connection_id: "11111111-1111-1111-1111-111111111111",
            shop_domain: "enfakt-v6.myshopify.com",
          },
        ],
      }),
    );
    const query = signShopifyQuery(
      { shop: "enfakt-v6.myshopify.com", timestamp: "123" },
      "secret_test",
    );
    const res = await dispatch(new Request(launchUrl(query)));
    assert.equal(res.status, 302);
    assert.equal(
      locationOf(res),
      "https://channels.devjewels.com/connect/success?connected=1",
    );
  });
}

async function testNoInviteNotConnectedRedirectsInstalled(): Promise<void> {
  await withOauthEnv(async () => {
    const query = signShopifyQuery(
      { shop: "unknown-shop.myshopify.com", timestamp: "123" },
      "secret_test",
    );
    const res = await dispatch(new Request(launchUrl(query)));
    assert.equal(res.status, 302);
    assert.equal(
      locationOf(res),
      "https://channels.devjewels.com/connect/success?installed=1",
    );
    const page = await dispatch(
      new Request("https://channels.devjewels.com/connect/success?installed=1"),
    );
    assert.equal(page.status, 200);
    const body = await page.text();
    assert.ok(body.includes(CONNECT_INSTALLED_BODY));
  });
}

async function testShopWithoutHmacIs401(): Promise<void> {
  await withOauthEnv(async () => {
    const res = await dispatch(
      new Request(
        "https://channels.devjewels.com/?shop=enfakt-v6.myshopify.com",
      ),
    );
    assert.equal(res.status, 401);
    const body = await res.text();
    assert.equal(body, JSON.stringify({ error: "Unauthorized" }));
  });
}

async function main(): Promise<void> {
  await testBareRootIsHtmlNotJson404();
  await testInvalidHmacIsGeneric401();
  await testPendingInviteRedirectsToOauth();
  await testInviteCustomerIdIsNotHardcoded();
  await testConnectedShopRedirectsToSuccess();
  await testNoInviteNotConnectedRedirectsInstalled();
  await testShopWithoutHmacIs401();
  console.log("appLaunch self-check ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
