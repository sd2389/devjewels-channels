/**
 * Shopify webhook HMAC verification + registration helpers.
 * Never log access tokens.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { getShopifyMetaStore } from "./meta";

/** Topics handled by apps/core Shopify webhook route (order processing). */
export const SHOPIFY_ORDER_WEBHOOK_TOPICS = [
  "orders/create",
  "orders/updated",
  "orders/paid",
] as const;

export function verifyShopifyWebhookHmac(input: {
  rawBody: string | Buffer;
  hmacHeader: string | undefined;
  secret: string;
}): boolean {
  const secret = input.secret?.trim();
  const hmacHeader = (input.hmacHeader || "").trim();
  if (!secret || !hmacHeader) {
    return false;
  }

  const digest = createHmac("sha256", secret)
    .update(input.rawBody)
    .digest("base64");

  try {
    const a = Buffer.from(digest, "utf8");
    const b = Buffer.from(hmacHeader, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function parseShopifyWebhookTopic(
  headers: Record<string, string | string[] | undefined>,
): string {
  const raw = headers["x-shopify-topic"] ?? headers["X-Shopify-Topic"];
  const topic = Array.isArray(raw) ? raw[0] : raw;
  return topic ?? "";
}

export function parseShopifyWebhookId(
  headers: Record<string, string | string[] | undefined>,
): string {
  const raw =
    headers["x-shopify-webhook-id"] ??
    headers["X-Shopify-Webhook-Id"] ??
    headers["x-shopify-event-id"] ??
    headers["X-Shopify-Event-Id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value || "").trim();
}

export function parseShopifyShopDomain(
  headers: Record<string, string | string[] | undefined>,
): string {
  const raw =
    headers["x-shopify-shop-domain"] ?? headers["X-Shopify-Shop-Domain"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value || "").trim().toLowerCase();
}

export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

function normalizeShopDomain(shopDomain: string): string {
  return shopDomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

export type RegisterShopifyWebhooksResult = {
  topic: string;
  externalWebhookId: string;
  created: boolean;
};

/**
 * Ensure order webhooks point at Channels. Idempotent per topic (reuse existing address).
 */
export async function registerShopifyWebhooks(input: {
  shopDomain: string;
  accessToken: string;
  callbackUrl: string;
  connectionId: string;
  topics?: readonly string[];
  apiVersion?: string;
  fetchImpl?: typeof fetch;
}): Promise<RegisterShopifyWebhooksResult[]> {
  const shopDomain = normalizeShopDomain(input.shopDomain);
  const accessToken = input.accessToken.trim();
  const callbackUrl = input.callbackUrl.trim();
  if (!shopDomain || !accessToken || !callbackUrl) {
    throw new Error("shopDomain, accessToken, and callbackUrl are required");
  }
  if (!/^https?:\/\//i.test(callbackUrl)) {
    throw new Error("Webhook callbackUrl must be an absolute http(s) URL");
  }

  const topics = [...(input.topics ?? SHOPIFY_ORDER_WEBHOOK_TOPICS)];
  const apiVersion =
    input.apiVersion ?? process.env.SHOPIFY_API_VERSION ?? "2025-01";
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const base = `https://${shopDomain}/admin/api/${apiVersion}/webhooks`;

  const listRes = await fetchImpl(`${base}.json`, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": accessToken,
      Accept: "application/json",
    },
  });
  if (!listRes.ok) {
    throw new Error(`Shopify list webhooks failed (HTTP ${listRes.status})`);
  }
  const listBody = (await listRes.json()) as {
    webhooks?: Array<{ id: number | string; topic: string; address: string }>;
  };
  const existing = listBody.webhooks ?? [];
  const meta = getShopifyMetaStore();
  const out: RegisterShopifyWebhooksResult[] = [];

  for (const topic of topics) {
    const match = existing.find(
      (w) =>
        w.topic === topic &&
        w.address.replace(/\/$/, "") === callbackUrl.replace(/\/$/, ""),
    );
    if (match) {
      const id = String(match.id);
      await meta.upsertWebhookSubscription({
        connectionId: input.connectionId,
        topic,
        externalWebhookId: id,
      });
      out.push({ topic, externalWebhookId: id, created: false });
      continue;
    }

    const createRes = await fetchImpl(`${base}.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        webhook: {
          topic,
          address: callbackUrl,
          format: "json",
        },
      }),
    });
    if (!createRes.ok) {
      throw new Error(
        `Shopify create webhook ${topic} failed (HTTP ${createRes.status})`,
      );
    }
    const createdBody = (await createRes.json()) as {
      webhook?: { id?: number | string };
    };
    const id = String(createdBody.webhook?.id ?? "");
    if (!id) {
      throw new Error(`Shopify create webhook ${topic} returned no id`);
    }
    await meta.upsertWebhookSubscription({
      connectionId: input.connectionId,
      topic,
      externalWebhookId: id,
    });
    out.push({ topic, externalWebhookId: id, created: true });
  }

  return out;
}
