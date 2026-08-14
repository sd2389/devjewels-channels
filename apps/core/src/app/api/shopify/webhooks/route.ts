/**
 * Shopify webhook HTTP handler (core runtime route).
 * - Compliance topics (public apps): HMAC with app Client Secret → 200 (even if shop unknown)
 * - Order topics: connection HMAC → enqueue order-processing
 */
import { NextRequest, NextResponse } from "next/server";
import { registerDefaultAdapters } from "@/channels/registerAdapters";
import { AdapterRouter } from "@/channels/router";
import { getConnectionById } from "@/services/connections";
import { resolveShopifyCredentials } from "@/security/secrets";
import { enqueueOrderProcessing } from "@/services/queue";
import { getWebhookEventStore } from "@/services/webhookEvents";
import {
  handleShopifyCustomerCompliance,
  handleShopifyShopRedact,
  isShopifyComplianceTopic,
} from "@/services/shopifyCompliance";
import { getShopifyOAuthConfig } from "@devjewels-channels/shopify/auth";
import {
  headerValue,
  parseShopifyShopDomain,
  parseShopifyWebhookId,
  parseShopifyWebhookTopic,
  verifyShopifyWebhookHmac,
} from "@devjewels-channels/shopify/webhooks";
import { getShopifyMetaStore } from "@devjewels-channels/shopify";

let adaptersReady = false;

function ensureAdapters(): void {
  if (!adaptersReady) {
    registerDefaultAdapters();
    adaptersReady = true;
  }
}

async function resolveWebhookSecret(connectionId: string): Promise<string> {
  const envSecret = (process.env.CHANNELS_SHOPIFY_WEBHOOK_SECRET || "").trim();
  if (envSecret) return envSecret;
  const connection = await getConnectionById(connectionId);
  const ref = connection?.credentials_secret_ref?.trim();
  if (!ref) return "";
  try {
    const credentials = await resolveShopifyCredentials(ref);
    return credentials.webhookSecret?.trim() || "";
  } catch {
    return "";
  }
}

async function handleCompliancePost(
  rawBody: string,
  headers: Record<string, string>,
  topic: string,
): Promise<NextResponse> {
  const shopDomain = parseShopifyShopDomain(headers);
  let apiSecret = "";
  try {
    apiSecret = (await getShopifyOAuthConfig()).apiSecret;
  } catch {
    apiSecret = (process.env.SHOPIFY_API_SECRET || "").trim();
  }
  const hmacHeader =
    headerValue(headers, "x-shopify-hmac-sha256") ||
    headerValue(headers, "X-Shopify-Hmac-Sha256");
  if (
    !apiSecret ||
    !verifyShopifyWebhookHmac({ rawBody, hmacHeader, secret: apiSecret })
  ) {
    console.warn("shopify_compliance_hmac_rejected", { topic, shopDomain });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (topic === "shop/redact") {
    await handleShopifyShopRedact(shopDomain);
  } else if (topic === "customers/data_request" || topic === "customers/redact") {
    await handleShopifyCustomerCompliance(topic, shopDomain);
  }

  return NextResponse.json(
    { accepted: true, compliance: true, topic },
    { status: 200 },
  );
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const headers = Object.fromEntries(request.headers.entries());
  const topic = parseShopifyWebhookTopic(headers);
  const shopDomain = parseShopifyShopDomain(headers);
  const externalEventId =
    parseShopifyWebhookId(headers) ||
    `${topic}:${Buffer.from(rawBody).toString("base64url").slice(0, 32)}`;

  if (isShopifyComplianceTopic(topic)) {
    return handleCompliancePost(rawBody, headers, topic);
  }

  if (!shopDomain) {
    return NextResponse.json({ error: "Missing shop domain" }, { status: 400 });
  }

  ensureAdapters();

  let connectionId: string | null = null;
  try {
    connectionId = await getShopifyMetaStore().getConnectionIdByShopDomain(shopDomain);
  } catch {
    connectionId = null;
  }

  if (!connectionId) {
    connectionId = (process.env.CHANNELS_SHOPIFY_DEFAULT_CONNECTION_ID || "").trim() || null;
  }

  if (!connectionId) {
    return NextResponse.json({ error: "Unknown shop" }, { status: 404 });
  }

  const secret = await resolveWebhookSecret(connectionId);
  const hmacHeader =
    headerValue(headers, "x-shopify-hmac-sha256") ||
    headerValue(headers, "X-Shopify-Hmac-Sha256");
  if (!secret || !verifyShopifyWebhookHmac({ rawBody, hmacHeader, secret })) {
    console.warn("shopify_webhook_hmac_rejected", {
      shopDomain,
      topic,
    });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  process.env.CHANNELS_SHOPIFY_WEBHOOK_SECRET = secret;
  try {
    await AdapterRouter.get("SHOPIFY").verifyWebhook({
      connectionId,
      headers,
      rawBody,
    });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isOrderTopic =
    topic === "orders/create" ||
    topic === "orders/updated" ||
    topic === "orders/paid";

  const claim = await getWebhookEventStore().claim({
    connectionId,
    platform: "SHOPIFY",
    externalEventId,
    topic: topic || "unknown",
    payloadRef: rawBody.slice(0, 200_000),
  });

  if (claim.duplicate) {
    return NextResponse.json(
      {
        accepted: true,
        duplicate: true,
        webhookEventId: claim.row.id,
        topic,
      },
      { status: 200 },
    );
  }

  if (isOrderTopic) {
    await enqueueOrderProcessing({
      kind: "order.process",
      connectionId,
      platform: "SHOPIFY",
      webhookEventId: claim.row.id,
    });
  }

  return NextResponse.json(
    {
      accepted: true,
      duplicate: false,
      webhookEventId: claim.row.id,
      topic,
      enqueued: isOrderTopic,
    },
    { status: 200 },
  );
}
