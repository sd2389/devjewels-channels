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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * iMessage/Slack previews GET the URL and must not burn the single-use jti.
 * The merchant starts OAuth only by submitting this form.
 */
function renderContinuePage(token: string): Response {
  const safe = escapeHtml(token);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="robots" content="noindex,nofollow"/>
  <title>Connect Shopify</title>
  <style>
    body { margin:0; font-family: ui-sans-serif, system-ui, sans-serif; background:#0f1115; color:#e8eaed; }
    .card { max-width:480px; margin:3rem auto; padding:2rem; border-radius:16px; border:1px solid #2a2f3a; background:#161922; text-align:center; }
    h1 { font-size:1.4rem; font-weight:600; margin:0 0 0.75rem; }
    p { margin:0 0 1.25rem; line-height:1.6; opacity:0.85; }
    button { min-height:44px; padding:0.7rem 1.25rem; border:0; border-radius:10px; background:#e8eaed; color:#0f1115; font-size:1rem; font-weight:600; }
    .foot { margin-top:1.75rem; font-size:.875rem; opacity:.55; }
    a { color:#93c5fd; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Connect your Shopify store</h1>
    <p>Tap the button to approve the DevJewels app. Opening this link in a message preview does not start the install.</p>
    <form method="post" action="/api/connect/shopify">
      <input type="hidden" name="token" value="${safe}"/>
      <button type="submit">Continue to Shopify</button>
    </form>
    <p class="foot">Questions? <a href="mailto:support@devjewels.com">Contact DevJewels</a></p>
  </main>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}

async function tokenFromRequest(request: Request): Promise<string> {
  if (request.method === "POST") {
    const form = await request.formData();
    return String(form.get("token") || "").trim();
  }
  return new URL(request.url).searchParams.get("token")?.trim() || "";
}

async function beginShopifyOauth(request: Request, token: string): Promise<Response> {
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

  const authUrl = new URL("/api/shopify/auth", new URL(request.url).origin);
  authUrl.searchParams.set("shop", payload.shop);
  authUrl.searchParams.set("customer_id", String(payload.customer_id));
  authUrl.searchParams.set("merchant", "1");
  return redirect(authUrl.toString(), 302);
}

/**
 * GET /api/connect/shopify?token=
 * Public page. Does not consume the invite (link previews must be safe).
 */
export async function getConnectShopify(request: Request): Promise<Response> {
  const token = await tokenFromRequest(request);
  if (!token) {
    return inviteFail(request, "invalid_invite");
  }
  const verified = verifyShopifyInviteToken(token);
  if (!verified.ok) {
    return inviteFail(request, "invalid_invite");
  }
  return renderContinuePage(token);
}

/** POST — merchant tapped Continue. Consume jti and redirect to OAuth. */
export async function postConnectShopify(request: Request): Promise<Response> {
  const token = await tokenFromRequest(request);
  if (!token) {
    return inviteFail(request, "invalid_invite");
  }
  return beginShopifyOauth(request, token);
}
