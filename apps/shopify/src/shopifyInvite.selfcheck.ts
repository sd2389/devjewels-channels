/**
 * Self-check: signed Shopify connect invite tokens + single-use jti store.
 */
import assert from "node:assert/strict";
import {
  createInviteJti,
  SHOPIFY_INVITE_TTL_MS,
  signShopifyInviteToken,
  verifyShopifyInviteToken,
} from "./shopifyInvite";
import {
  createMemoryShopifyInviteStore,
  setShopifyInviteStoreForTests,
} from "./inviteStore";
import { isMerchantOAuthState, parseCustomerIdFromOAuthState } from "./auth";

process.env.CHANNELS_INVITE_SIGNING_SECRET = "selfcheck-invite-secret";

function testSignVerifyRoundTrip() {
  const jti = createInviteJti();
  const expiresAt = new Date(Date.now() + SHOPIFY_INVITE_TTL_MS);
  const token = signShopifyInviteToken({
    customerId: 42,
    shop: "Example-Store.myshopify.com",
    jti,
    expiresAt,
  });
  const verified = verifyShopifyInviteToken(token);
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.equal(verified.payload.customer_id, 42);
  assert.equal(verified.payload.shop, "example-store.myshopify.com");
  assert.equal(verified.payload.jti, jti);
}

function testExpiredTokenRejected() {
  const jti = createInviteJti();
  const expiresAt = new Date(Date.now() - 1000);
  const token = signShopifyInviteToken({
    customerId: 1,
    shop: "store.myshopify.com",
    jti,
    expiresAt,
  });
  const verified = verifyShopifyInviteToken(token);
  assert.equal(verified.ok, false);
  if (verified.ok) return;
  assert.equal(verified.reason, "expired");
}

function testBadSignatureRejected() {
  const jti = createInviteJti();
  const expiresAt = new Date(Date.now() + 60_000);
  const token = signShopifyInviteToken({
    customerId: 1,
    shop: "store.myshopify.com",
    jti,
    expiresAt,
  });
  const tampered = `${token}x`;
  const verified = verifyShopifyInviteToken(tampered);
  assert.equal(verified.ok, false);
}

async function testSingleUseJti() {
  const store = createMemoryShopifyInviteStore();
  setShopifyInviteStoreForTests(store);
  const jti = createInviteJti();
  const expiresAt = new Date(Date.now() + SHOPIFY_INVITE_TTL_MS);
  await store.createInvite({
    jti,
    customerId: 99,
    shopDomain: "jeweler.myshopify.com",
    expiresAt,
  });
  const first = await store.consumeInvite(jti);
  assert.ok(first);
  const second = await store.consumeInvite(jti);
  assert.equal(second, null);
  setShopifyInviteStoreForTests(null);
}

function testMerchantOAuthStateParsing() {
  const state = `${crypto.randomUUID()}.1234.m`;
  assert.equal(parseCustomerIdFromOAuthState(state), 1234);
  assert.equal(isMerchantOAuthState(state), true);
  const staffState = `${crypto.randomUUID()}.5678`;
  assert.equal(parseCustomerIdFromOAuthState(staffState), 5678);
  assert.equal(isMerchantOAuthState(staffState), false);
}

async function main() {
  testSignVerifyRoundTrip();
  testExpiredTokenRejected();
  testBadSignatureRejected();
  await testSingleUseJti();
  testMerchantOAuthStateParsing();
  console.log("shopifyInvite self-check ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
