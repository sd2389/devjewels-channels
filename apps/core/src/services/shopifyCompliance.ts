/**
 * Shopify mandatory compliance webhooks (public / App Store apps).
 * HMAC uses the Partner app Client Secret — not a per-store token.
 * Never log customer email/phone from payloads.
 */
import { setConnectionActive } from "@/services/connections";
import { getShopifyMetaStore } from "@devjewels-channels/shopify";

export const SHOPIFY_COMPLIANCE_TOPICS = [
  "customers/data_request",
  "customers/redact",
  "shop/redact",
] as const;

export type ShopifyComplianceTopic = (typeof SHOPIFY_COMPLIANCE_TOPICS)[number];

export function isShopifyComplianceTopic(
  topic: string,
): topic is ShopifyComplianceTopic {
  return (SHOPIFY_COMPLIANCE_TOPICS as readonly string[]).includes(topic);
}

function normalizeShopDomain(shop: string): string {
  return shop
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

/**
 * 48h after uninstall: stop channel for that shop.
 * Product data on Shopify is already gone with the app; we deactivate local connection.
 */
export async function handleShopifyShopRedact(
  shopDomain: string,
): Promise<{ connectionId: string | null; deactivated: boolean }> {
  const domain = normalizeShopDomain(shopDomain);
  if (!domain) {
    return { connectionId: null, deactivated: false };
  }
  let connectionId: string | null = null;
  try {
    connectionId = await getShopifyMetaStore().getConnectionIdByShopDomain(domain);
  } catch {
    connectionId = null;
  }
  if (!connectionId) {
    console.info("shopify_shop_redact_unknown_shop", { shopDomain: domain });
    return { connectionId: null, deactivated: false };
  }
  await setConnectionActive(connectionId, false);
  console.info("shopify_shop_redact_deactivated", {
    shopDomain: domain,
    connectionId,
  });
  return { connectionId, deactivated: true };
}

/**
 * Customer data request / redact — Channels does not store Shopify customer PII
 * as SoT; acknowledge and record for ops. Complete within Shopify's window if
 * any connection-scoped logs hold order payloads.
 */
export async function handleShopifyCustomerCompliance(
  topic: "customers/data_request" | "customers/redact",
  shopDomain: string,
): Promise<void> {
  const domain = normalizeShopDomain(shopDomain) || "unknown";
  console.info("shopify_customer_compliance_ack", { topic, shopDomain: domain });
}
