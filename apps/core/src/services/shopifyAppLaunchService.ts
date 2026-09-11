/**
 * Shopify Admin opens application_url (GET /) after Custom install.
 * Decide OAuth vs success vs finish-setup. Never throws to the merchant path.
 */
import {
  assertMyshopifyDomain,
  getShopifyOAuthConfig,
  ShopifyOAuthConfigError,
  verifyShopifyOAuthCallbackHmac,
} from "@devjewels-channels/shopify/auth";
import { getShopifyInviteStore } from "@devjewels-channels/shopify/inviteStore";
import { getShopifyMetaStore } from "@devjewels-channels/shopify";

export type ShopifyAppLaunchResult =
  | { kind: "home" }
  | { kind: "unauthorized" }
  | { kind: "oauth"; shop: string; customerId: number }
  | { kind: "connected" }
  | { kind: "finish_setup" }
  | { kind: "oauth_not_configured" };

export async function resolveShopifyAppLaunch(
  query: URLSearchParams,
): Promise<ShopifyAppLaunchResult> {
  const shopRaw = query.get("shop")?.trim() || "";
  const hmac = query.get("hmac")?.trim() || "";

  if (!shopRaw && !hmac) {
    return { kind: "home" };
  }

  if (!shopRaw || !hmac) {
    return { kind: "unauthorized" };
  }

  let shop: string;
  try {
    shop = assertMyshopifyDomain(shopRaw);
  } catch {
    return { kind: "unauthorized" };
  }

  let apiSecret: string;
  try {
    apiSecret = (await getShopifyOAuthConfig()).apiSecret;
  } catch (err) {
    if (err instanceof ShopifyOAuthConfigError) {
      return { kind: "oauth_not_configured" };
    }
    return { kind: "finish_setup" };
  }

  if (!verifyShopifyOAuthCallbackHmac(query, apiSecret)) {
    return { kind: "unauthorized" };
  }

  // Connected shops first: leftover pending invites must not restart OAuth.
  try {
    const connectionId =
      await getShopifyMetaStore().getConnectionIdByShopDomain(shop);
    if (connectionId) {
      return { kind: "connected" };
    }
  } catch (err) {
    console.error("shopify_app_launch_connection_lookup_failed", {
      shop,
      error_type: err instanceof Error ? err.name : "Error",
    });
    return { kind: "finish_setup" };
  }

  try {
    const invite = await getShopifyInviteStore().findPendingByShopDomain(shop);
    const customerId = invite ? Number(invite.customer_id) : 0;
    if (invite && Number.isInteger(customerId) && customerId > 0) {
      return { kind: "oauth", shop, customerId };
    }
  } catch (err) {
    console.error("shopify_app_launch_invite_lookup_failed", {
      shop,
      error_type: err instanceof Error ? err.name : "Error",
    });
  }

  return { kind: "finish_setup" };
}
