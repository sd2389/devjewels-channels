import { NextRequest, NextResponse } from "next/server";
import {
  exchangeShopifyOAuthCode,
  getShopifyOAuthConfig,
  parseCustomerIdFromOAuthState,
  ShopifyOAuthConfigError,
  verifyShopifyOAuthCallbackHmac,
} from "@devjewels-channels/shopify/auth";
import { connectShopifyStore } from "@/services/connectShopifyService";

/**
 * Shopify OAuth callback — exchange code, persist connection bound to customer_id.
 * GET /api/shopify/auth/callback?shop=&code=&state=&hmac=
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const shop = params.get("shop");
  const code = params.get("code");
  const state = params.get("state");

  const dashboard = (path: string) => {
    const base =
      process.env.CHANNELS_PUBLIC_BASE_URL?.trim().replace(/\/$/, "") ||
      request.nextUrl.origin;
    return NextResponse.redirect(new URL(path, `${base}/`));
  };

  if (!shop?.trim() || !code?.trim() || !state?.trim()) {
    return dashboard("/?shopify_error=missing_oauth_params");
  }

  try {
    const config = await getShopifyOAuthConfig();
    if (!verifyShopifyOAuthCallbackHmac(params, config.apiSecret)) {
      return dashboard("/?shopify_error=invalid_hmac");
    }

    const customerId = parseCustomerIdFromOAuthState(state);
    if (customerId == null) {
      return dashboard("/?shopify_error=missing_customer");
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
    return dashboard(`/?${qs.toString()}`);
  } catch (err) {
    if (err instanceof ShopifyOAuthConfigError) {
      return dashboard("/?shopify_error=oauth_not_configured");
    }
    const message = err instanceof Error ? err.message : "";
    if (/invalid or expired oauth state|shop mismatch/i.test(message)) {
      return dashboard("/?shopify_error=invalid_state");
    }
    if (/already connected|another customer|API key/i.test(message)) {
      return dashboard("/?shopify_error=connect_failed");
    }
    console.warn("shopify_oauth_callback_failed", {
      shop: shop.trim().toLowerCase(),
      error: message.slice(0, 200),
    });
    return dashboard("/?shopify_error=connect_failed");
  }
}
