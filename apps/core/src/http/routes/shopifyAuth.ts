import { optionalProcessEnv } from "@/config/serverEnv";
import {
  beginShopifyOAuthInstall,
  exchangeShopifyOAuthCode,
  getShopifyOAuthConfig,
  isMerchantOAuthState,
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
  const merchantSuccess = url.searchParams.get("merchant") === "1";
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
    const { url: authorizeUrl } = await beginShopifyOAuthInstall(shop, customerId, {
      merchantSuccess,
    });
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

function oauthReturnBase(request: Request, merchantSuccess: boolean): string {
  if (merchantSuccess) {
    const publicBase = optionalProcessEnv("CHANNELS_PUBLIC_BASE_URL")?.replace(/\/$/, "");
    if (publicBase) return publicBase;
    return new URL(request.url).origin;
  }
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

  const go = (path: string, merchantSuccess = false) => {
    const base = oauthReturnBase(request, merchantSuccess);
    return redirect(new URL(path, `${base}/`));
  };

  if (!shop?.trim() || !code?.trim() || !state?.trim()) {
    return go("/connect/success?shopify_error=missing_oauth_params", isMerchantOAuthState(state ?? ""));
  }

  const merchantFlow = isMerchantOAuthState(state);

  const merchantErrorPath = (errorCode: string) =>
    merchantFlow ? `/connect/success?shopify_error=${errorCode}` : `/?shopify_error=${errorCode}`;

  try {
    const config = await getShopifyOAuthConfig();
    if (!verifyShopifyOAuthCallbackHmac(params, config.apiSecret)) {
      return go(merchantErrorPath("invalid_hmac"), merchantFlow);
    }

    const customerId = parseCustomerIdFromOAuthState(state);
    if (customerId == null) {
      return go(merchantErrorPath("missing_customer"), merchantFlow);
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

    if (merchantFlow) {
      const qs = new URLSearchParams({
        connected: "1",
        ...(result.reconnected ? { reconnected: "1" } : {}),
      });
      return go(`/connect/success?${qs.toString()}`, true);
    }

    const qs = new URLSearchParams({
      connected: result.connection.id,
      ...(result.reconnected ? { reconnected: "1" } : {}),
    });
    return go(`/?${qs.toString()}`, false);
  } catch (err) {
    if (err instanceof ShopifyOAuthConfigError) {
      return go(merchantErrorPath("oauth_not_configured"), merchantFlow);
    }
    const message = err instanceof Error ? err.message : "";
    if (/invalid or expired oauth state|shop mismatch/i.test(message)) {
      return go(merchantErrorPath("invalid_state"), merchantFlow);
    }
    if (/already connected|another customer|API key/i.test(message)) {
      return go(merchantErrorPath("connect_failed"), merchantFlow);
    }
    console.warn("shopify_oauth_callback_failed", {
      shop: shop.trim().toLowerCase(),
      error: message.slice(0, 200),
    });
    return go(merchantErrorPath("connect_failed"), merchantFlow);
  }
}
