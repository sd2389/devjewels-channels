import { optionalProcessEnv } from "@/config/serverEnv";
import {
  beginShopifyOAuthInstall,
  exchangeShopifyOAuthCode,
  getShopifyOAuthConfig,
  parseCustomerIdFromOAuthState,
  ShopifyOAuthConfigError,
  verifyShopifyOAuthCallbackHmac,
} from "@devjewels-channels/shopify/auth";
import { connectShopifyStore } from "@/services/connectShopifyService";
import { json, redirect } from "../response";

/**
 * GET /api/shopify/auth?shop=&customer_id=
 */
export async function getShopifyAuthStart(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const customerIdRaw = url.searchParams.get("customer_id");
  if (!shop?.trim()) {
    return json({ error: "Missing shop (expected *.myshopify.com)" }, 400);
  }
  const customerId = Number(customerIdRaw);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return json(
      { error: "customer_id is required (DevJewels Customer.pk)" },
      400,
    );
  }
  try {
    const { url: authorizeUrl } = await beginShopifyOAuthInstall(shop, customerId);
    return redirect(authorizeUrl, 302);
  } catch (err) {
    if (err instanceof ShopifyOAuthConfigError) {
      return json({ error: err.message }, 503);
    }
    const message =
      err instanceof Error ? err.message : "Shopify OAuth start failed";
    if (/DATABASE_URL|meta store/i.test(message)) {
      return json(
        { error: "Channels database is not configured (set DATABASE_URL)" },
        503,
      );
    }
    const status = /must be a \*\.myshopify\.com|customer_id/i.test(message)
      ? 400
      : 500;
    return json(
      { error: status === 500 ? "Shopify OAuth start failed" : message },
      status,
    );
  }
}

function oauthReturnBase(request: Request): string {
  const explicit =
    optionalProcessEnv("CHANNELS_OAUTH_SUCCESS_URL")?.replace(/\/$/, "") ||
    optionalProcessEnv("CHANNELS_PUBLIC_BASE_URL")?.replace(/\/$/, "");
  if (explicit) return explicit;
  return new URL(request.url).origin;
}

/**
 * GET /api/shopify/auth/callback
 * Without Channels UI: redirects to CHANNELS_OAUTH_SUCCESS_URL or CHANNELS_PUBLIC_BASE_URL.
 */
export async function getShopifyAuthCallback(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const params = url.searchParams;
  const shop = params.get("shop");
  const code = params.get("code");
  const state = params.get("state");

  const go = (path: string) => {
    const base = oauthReturnBase(request);
    return redirect(new URL(path, `${base}/`));
  };

  if (!shop?.trim() || !code?.trim() || !state?.trim()) {
    return go("/?shopify_error=missing_oauth_params");
  }

  try {
    const config = await getShopifyOAuthConfig();
    if (!verifyShopifyOAuthCallbackHmac(params, config.apiSecret)) {
      return go("/?shopify_error=invalid_hmac");
    }

    const customerId = parseCustomerIdFromOAuthState(state);
    if (customerId == null) {
      return go("/?shopify_error=missing_customer");
    }

    const token = await exchangeShopifyOAuthCode({
      shop,
      code,
      state,
    });

    const result = await connectShopifyStore({
      shopDomain: token.shopDomain,
      accessToken: token.accessToken,
      webhookSecret: config.apiSecret,
      customerId,
    });

    const qs = new URLSearchParams({
      connected: result.connection.id,
      ...(result.reconnected ? { reconnected: "1" } : {}),
    });
    return go(`/?${qs.toString()}`);
  } catch (err) {
    if (err instanceof ShopifyOAuthConfigError) {
      return go("/?shopify_error=oauth_not_configured");
    }
    const message = err instanceof Error ? err.message : "";
    if (/invalid or expired oauth state|shop mismatch/i.test(message)) {
      return go("/?shopify_error=invalid_state");
    }
    if (/already connected|another customer|API key/i.test(message)) {
      return go("/?shopify_error=connect_failed");
    }
    console.warn("shopify_oauth_callback_failed", {
      shop: shop.trim().toLowerCase(),
      error: message.slice(0, 200),
    });
    return go("/?shopify_error=connect_failed");
  }
}
