/**
 * Pick OAuth app credentials for a *new* merchant install.
 * Public DevJewels-Channels first — Custom BuffedBubbly is single-store and
 * must never be offered to a different jeweler (wrong app name + invalid link).
 */
import {
  assertMyshopifyDomain,
  getPublicShopifyOAuthConfig,
  getShopifyOAuthConfig,
  isPublicShopifyClientId,
  type ShopifyOAuthConfig,
} from "@devjewels-channels/shopify/auth";
import { getShopifyMetaStore } from "@devjewels-channels/shopify";
import { listConnections } from "@/services/connections";

export const CUSTOM_APP_ALREADY_BOUND_MESSAGE =
  "The Custom Shopify app (BuffedBubbly) is already connected to another store. Configure Public DevJewels-Channels credentials (SHOPIFY_PUBLIC_API_KEY / SHOPIFY_PUBLIC_API_SECRET) before inviting a new merchant.";

export async function resolveMerchantInstallOAuthConfig(
  shop: string,
): Promise<ShopifyOAuthConfig> {
  const shopDomain = assertMyshopifyDomain(shop);

  const publicConfig = await getPublicShopifyOAuthConfig();
  if (publicConfig) return publicConfig;

  const primary = await getShopifyOAuthConfig();
  if (isPublicShopifyClientId(primary.apiKey)) return primary;

  const meta = getShopifyMetaStore();
  try {
    const existingForShop = await meta.getConnectionIdByShopDomain(shopDomain);
    if (existingForShop) return primary;
  } catch {
    // Meta store unavailable (local selfcheck without channels DB role).
    return primary;
  }

  let connections;
  try {
    connections = await listConnections(100);
  } catch {
    // Unit tests / misconfig without DATABASE_URL — cannot prove another shop
    // is bound. Public credentials are preferred above; Custom first-install
    // without a connection store is allowed.
    return primary;
  }
  for (const connection of connections) {
    if (!connection.is_active) continue;
    const shopRow = await meta.getShop(connection.id);
    if (
      shopRow?.shop_domain &&
      shopRow.shop_domain.trim().toLowerCase() !== shopDomain
    ) {
      throw new Error(CUSTOM_APP_ALREADY_BOUND_MESSAGE);
    }
  }

  return primary;
}
