/**
 * Where a merchant OAuth callback goes when DevJewels cannot bind the shop.
 * App Store review installs use the fallback customer and have no API key.
 * Showing "Could not connect store" fails Shopify requirement 2.1.1.
 */

export type MerchantOAuthFailureTarget = "invalid_state" | "installed" | "connect_failed";

export function merchantOAuthFailureTarget(input: {
  merchantFlow: boolean;
  customerId: number | null;
  fallbackCustomerId: number | null;
  message: string;
}): MerchantOAuthFailureTarget {
  if (/invalid or expired oauth state|shop mismatch/i.test(input.message)) {
    return "invalid_state";
  }
  const reviewInstall =
    input.merchantFlow &&
    input.fallbackCustomerId != null &&
    input.customerId === input.fallbackCustomerId;
  if (reviewInstall) return "installed";
  if (
    input.merchantFlow &&
    /already has a channel connection/i.test(input.message)
  ) {
    return "installed";
  }
  return "connect_failed";
}
