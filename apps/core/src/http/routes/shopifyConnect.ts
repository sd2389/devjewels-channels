import {
  verifyShopifyInviteToken,
} from "@devjewels-channels/shopify/shopifyInvite";
import { getShopifyInviteStore } from "@devjewels-channels/shopify/inviteStore";
import { redirect } from "../response";

/**
 * GET /api/connect/shopify?token=
 * Public — verify signed invite, consume jti, redirect to OAuth start with locked params.
 */
export async function getConnectShopify(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token?.trim()) {
    return redirect("/connect/success?shopify_error=invalid_invite", 302);
  }

  const verified = verifyShopifyInviteToken(token);
  if (!verified.ok) {
    return redirect("/connect/success?shopify_error=invalid_invite", 302);
  }

  const { payload } = verified;
  const consumed = await getShopifyInviteStore().consumeInvite(payload.jti);
  if (!consumed) {
    return redirect("/connect/success?shopify_error=invite_used", 302);
  }

  if (
    consumed.customer_id !== payload.customer_id ||
    consumed.shop_domain.trim().toLowerCase() !== payload.shop.trim().toLowerCase()
  ) {
    return redirect("/connect/success?shopify_error=invalid_invite", 302);
  }

  const authUrl = new URL("/api/shopify/auth", url.origin);
  authUrl.searchParams.set("shop", payload.shop);
  authUrl.searchParams.set("customer_id", String(payload.customer_id));
  authUrl.searchParams.set("merchant", "1");
  return redirect(authUrl.toString(), 302);
}
