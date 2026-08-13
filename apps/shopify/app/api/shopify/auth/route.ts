/**
 * Ownership map: OAuth handler logic in apps/shopify/src/auth.ts
 * Runtime routes:
 *   apps/core/src/app/api/shopify/auth/route.ts
 *   apps/core/src/app/api/shopify/auth/callback/route.ts
 */
export {
  beginShopifyOAuthInstall,
  buildShopifyInstallUrl,
  exchangeShopifyOAuthCode,
  getShopifyOAuthConfig,
  ShopifyOAuthConfigError,
} from "../../../../src/auth";
