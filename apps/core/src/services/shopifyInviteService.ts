import { requireSyncableEntitlements } from "@/services/entitlements";
import { assertMyshopifyDomain } from "@devjewels-channels/shopify/auth";
import {
  buildShopifyInviteConnectUrl,
  channelsPublicOrigin,
  createInviteJti,
  SHOPIFY_INVITE_TTL_MS,
  signShopifyInviteToken,
} from "@devjewels-channels/shopify/shopifyInvite";
import { getShopifyInviteStore } from "@devjewels-channels/shopify/inviteStore";

export type CreateShopifyInviteResult = {
  inviteUrl: string;
  expiresAt: string;
  jti: string;
};

export async function createShopifyConnectInvite(input: {
  customerId: number;
  shopDomain: string;
}): Promise<CreateShopifyInviteResult> {
  const customerId = Number(input.customerId);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    throw new Error("customer_id is required (DevJewels Customer.pk)");
  }

  const shop = assertMyshopifyDomain(String(input.shopDomain || ""));

  const entitlements = await requireSyncableEntitlements(customerId);
  if (!entitlements) {
    throw new Error(
      "Customer needs an active API key with can_view_designs before generating a connect link",
    );
  }

  const jti = createInviteJti();
  const expiresAt = new Date(Date.now() + SHOPIFY_INVITE_TTL_MS);

  await getShopifyInviteStore().createInvite({
    jti,
    customerId,
    shopDomain: shop,
    expiresAt,
  });

  const token = signShopifyInviteToken({
    customerId,
    shop,
    jti,
    expiresAt,
  });

  return {
    inviteUrl: buildShopifyInviteConnectUrl(channelsPublicOrigin(), token),
    expiresAt: expiresAt.toISOString(),
    jti,
  };
}
