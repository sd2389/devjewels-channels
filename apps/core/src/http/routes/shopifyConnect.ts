import {
  verifyShopifyInviteToken,
} from "@devjewels-channels/shopify/shopifyInvite";
import { getShopifyInviteStore } from "@devjewels-channels/shopify/inviteStore";
import { redirect, redirectTo } from "../response";

function inviteFail(
  request: Request,
  error: "invalid_invite" | "invite_used",
): Response {
  return redirectTo(request, `/connect/success?shopify_error=${error}`);
}

/**
 * GET /api/connect/shopify?token=
 * Public — verify signed invite, consume jti, redirect to OAuth start with locked params.
 */
export async function getConnectShopify(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token?.trim()) {
    return inviteFail(request, "invalid_invite");
  }

  const verified = verifyShopifyInviteToken(token);
  if (!verified.ok) {
    return inviteFail(request, "invalid_invite");
  }

  const { payload } = verified;
  let consumed;
  try {
    consumed = await getShopifyInviteStore().consumeInvite(payload.jti);
  } catch (err) {
    console.error("shopify_invite_consume_failed", {
      error_type: err instanceof Error ? err.name : "Error",
      message: err instanceof Error ? err.message.slice(0, 200) : "unknown",
    });
    return inviteFail(request, "invalid_invite");
  }
  if (!consumed) {
    return inviteFail(request, "invite_used");
  }

  if (
    Number(consumed.customer_id) !== payload.customer_id ||
    consumed.shop_domain.trim().toLowerCase() !== payload.shop.trim().toLowerCase()
  ) {
    return inviteFail(request, "invalid_invite");
  }

  const authUrl = new URL("/api/shopify/auth", url.origin);
  authUrl.searchParams.set("shop", payload.shop);
  authUrl.searchParams.set("customer_id", String(payload.customer_id));
  authUrl.searchParams.set("merchant", "1");
  return redirect(authUrl.toString(), 302);
}
