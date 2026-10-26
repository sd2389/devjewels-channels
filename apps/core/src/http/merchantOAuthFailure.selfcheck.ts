/**
 * Run: npm run selfcheck:merchant-oauth-failure -w @devjewels-channels/core
 */
import assert from "node:assert/strict";
import { merchantOAuthFailureTarget } from "./merchantOAuthFailure";

const apiKeyMessage =
  "Customer needs an active API key with can_view_designs before connecting a channel";

assert.equal(
  merchantOAuthFailureTarget({
    merchantFlow: true,
    customerId: 993,
    fallbackCustomerId: 993,
    message: apiKeyMessage,
  }),
  "installed",
);

assert.equal(
  merchantOAuthFailureTarget({
    merchantFlow: true,
    customerId: 993,
    fallbackCustomerId: 993,
    message: "Connected, but Shopify webhook registration failed.",
  }),
  "installed",
);

assert.equal(
  merchantOAuthFailureTarget({
    merchantFlow: true,
    customerId: 826,
    fallbackCustomerId: 993,
    message: apiKeyMessage,
  }),
  "connect_failed",
);

assert.equal(
  merchantOAuthFailureTarget({
    merchantFlow: true,
    customerId: 826,
    fallbackCustomerId: 993,
    message: "This customer already has a channel connection",
  }),
  "installed",
);

assert.equal(
  merchantOAuthFailureTarget({
    merchantFlow: true,
    customerId: 993,
    fallbackCustomerId: 993,
    message: "invalid or expired oauth state",
  }),
  "invalid_state",
);

console.log("merchantOAuthFailure selfcheck ok");
