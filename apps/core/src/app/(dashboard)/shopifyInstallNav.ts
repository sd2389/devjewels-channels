/**
 * Shopify Install must use full-page navigation to /api/shopify/auth.
 * Never fetch that endpoint — browsers hide cross-origin 302 Location (opaque redirect).
 */

export function normalizeInstallShopDomain(shopRaw: string): string {
  return shopRaw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

/** Absolute OAuth start URL the browser must navigate to (top frame). */
export function buildShopifyInstallAuthUrl(
  origin: string,
  shopRaw: string,
  customerId: number,
): string {
  const shop = normalizeInstallShopDomain(shopRaw);
  if (!shop) {
    throw new Error("Enter your shop domain (your-store.myshopify.com)");
  }
  if (!Number.isInteger(customerId) || customerId <= 0) {
    throw new Error("Select a DevJewels customer. Customer must have an active API key.");
  }
  const base = origin.replace(/\/$/, "");
  const url = new URL(`${base}/api/shopify/auth`);
  url.searchParams.set("shop", shop);
  url.searchParams.set("customer_id", String(customerId));
  return url.toString();
}

/**
 * Navigate the top browsing context so Admin → Channels iframe is not stuck
 * (Shopify authorize pages refuse framing).
 */
export function assignTopLocation(href: string): void {
  const target = window.top ?? window;
  target.location.assign(href);
}
