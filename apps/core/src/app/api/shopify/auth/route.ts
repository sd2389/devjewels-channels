import { NextRequest, NextResponse } from "next/server";
import {
  beginShopifyOAuthInstall,
  ShopifyOAuthConfigError,
} from "@devjewels-channels/shopify/auth";

/**
 * Shopify OAuth start — redirect merchant to Shopify authorize URL.
 * GET /api/shopify/auth?shop=store.myshopify.com&customer_id=123
 */
export async function GET(request: NextRequest) {
  const shop = request.nextUrl.searchParams.get("shop");
  const customerIdRaw = request.nextUrl.searchParams.get("customer_id");
  if (!shop?.trim()) {
    return NextResponse.json(
      { error: "Missing shop (expected *.myshopify.com)" },
      { status: 400 },
    );
  }
  const customerId = Number(customerIdRaw);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return NextResponse.json(
      { error: "customer_id is required (DevJewels Customer.pk)" },
      { status: 400 },
    );
  }
  try {
    const { url } = await beginShopifyOAuthInstall(shop, customerId);
    return NextResponse.redirect(url);
  } catch (err) {
    if (err instanceof ShopifyOAuthConfigError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    const message =
      err instanceof Error ? err.message : "Shopify OAuth start failed";
    if (/DATABASE_URL|meta store/i.test(message)) {
      return NextResponse.json(
        { error: "Channels database is not configured (set DATABASE_URL)" },
        { status: 503 },
      );
    }
    const status = /must be a \*\.myshopify\.com|customer_id/i.test(message)
      ? 400
      : 500;
    return NextResponse.json(
      { error: status === 500 ? "Shopify OAuth start failed" : message },
      { status },
    );
  }
}
