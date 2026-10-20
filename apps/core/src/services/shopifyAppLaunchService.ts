/**
 * Shopify Admin opens application_url (GET /) after Custom install.
 * Decide OAuth vs success vs finish-setup. Never throws to the merchant path.
 *
 * Public App Store installs HMAC-sign with the Public app secret and must
 * immediately redirect to OAuth (no intermediate UI) — see App Store
 * "Immediately authenticates after install".
 */
import {
  assertMyshopifyDomain,
  isPublicShopifyClientId,
  listShopifyOAuthConfigs,
  matchShopifyOAuthConfigByHmac,
  ShopifyOAuthConfigError,
  type ShopifyOAuthConfig,
} from "@devjewels-channels/shopify/auth";
import { getShopifyInviteStore } from "@devjewels-channels/shopify/inviteStore";
import { getShopifyMetaStore } from "@devjewels-channels/shopify";
import { getConnectionByCustomerId } from "@/services/connections";

export type ShopifyAppLaunchResult =
  | { kind: "home" }
  | { kind: "unauthorized" }
  | {
      kind: "oauth";
      shop: string;
      customerId: number;
      clientId: string;
    }
  | { kind: "connected" }
  | { kind: "finish_setup" }
  | { kind: "oauth_not_configured" };

function resolveAppStoreFallbackCustomerId(
  config: ShopifyOAuthConfig,
): number | null {
  const cid = config.appStoreFallbackCustomerId;
  if (cid != null && Number.isInteger(cid) && cid > 0) return cid;
  return null;
}

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

  let matched: ShopifyOAuthConfig | null;
  try {
    await listShopifyOAuthConfigs();
    matched = await matchShopifyOAuthConfigByHmac(query);
  } catch (err) {
    if (err instanceof ShopifyOAuthConfigError) {
      return { kind: "oauth_not_configured" };
    }
    return { kind: "finish_setup" };
  }

  if (!matched) {
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
      return {
        kind: "oauth",
        shop,
        customerId,
        clientId: matched.apiKey,
      };
    }
  } catch (err) {
    console.error("shopify_app_launch_invite_lookup_failed", {
      shop,
      error_type: err instanceof Error ? err.name : "Error",
    });
  }

  // Public App Store automated install has no Channels invite. Shopify requires
  // an immediate OAuth redirect (not 401 / not intermediate UI). Only the Public
  // app may use the review fallback customer — never Custom BuffedBubbly (that
  // leaks another jeweler's app name / would bind the wrong customer).
  if (!isPublicShopifyClientId(matched.apiKey)) {
    return { kind: "finish_setup" };
  }

  const fallbackCustomerId = resolveAppStoreFallbackCustomerId(matched);
  if (fallbackCustomerId != null) {
    try {
      const existing = await getConnectionByCustomerId(fallbackCustomerId);
      if (existing) {
        // Fallback customer already owns a shop — do not OAuth-bind a new shop
        // to their entitlements (catalog leak). Merchant finishes via invite.
        return { kind: "finish_setup" };
      }
    } catch (err) {
      console.error("shopify_app_launch_fallback_customer_lookup_failed", {
        shop,
        error_type: err instanceof Error ? err.name : "Error",
      });
      // Fail open to OAuth for App Store review if connection store is down;
      // connectShopifyStore still enforces 1:1 shop↔customer.
    }
    return {
      kind: "oauth",
      shop,
      customerId: fallbackCustomerId,
      clientId: matched.apiKey,
    };
  }

  return { kind: "finish_setup" };
}
