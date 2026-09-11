/** Merchant-facing copy for /connect/success (Lambda HTML + local Next page). */

export const CONNECT_SUCCESS_ERRORS: Record<string, string> = {
  invalid_invite:
    "This install link is invalid or has expired. Ask DevJewels staff for a new link.",
  invite_used: "This install link was already used. Ask DevJewels staff for a new link.",
  missing_oauth_params: "Shopify install was cancelled or incomplete.",
  invalid_hmac:
    "Shopify install failed a security check. Try again from your install link.",
  invalid_state: "Install session expired. Open your install link again.",
  oauth_not_configured: "Shopify app is not configured yet. Contact DevJewels staff.",
  missing_customer: "Install link is missing customer context. Contact DevJewels staff.",
  connect_failed: "Could not finish connecting your store. Contact DevJewels staff.",
};

export const CONNECT_INSTALLED_TITLE = "App installed";
export const CONNECT_INSTALLED_BODY =
  "The DevJewels app is installed on your Shopify store. Return to DevJewels to finish connecting your catalog — you can close this page.";

export function connectSuccessErrorMessage(errorCode: string | null): string | null {
  if (!errorCode) return null;
  return CONNECT_SUCCESS_ERRORS[errorCode] ?? "Something went wrong.";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderConnectSuccessHtml(input: {
  connected: boolean;
  reconnected: boolean;
  errorCode: string | null;
  installed?: boolean;
}): string {
  const errorMessage = connectSuccessErrorMessage(input.errorCode);
  const ok = input.connected && !errorMessage;
  const installed = Boolean(input.installed) && !ok && !errorMessage;
  const title = ok
    ? input.reconnected
      ? "Store reconnected"
      : "Store connected"
    : installed
      ? CONNECT_INSTALLED_TITLE
      : "Could not connect store";
  const body = ok
    ? "Your Shopify store is linked to DevJewels. Our team will finish setup and sync your catalog — you can close this page."
    : installed
      ? CONNECT_INSTALLED_BODY
      : errorMessage || "Something went wrong.";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin:0; font-family: ui-sans-serif, system-ui, sans-serif; background:#0f1115; color:#e8eaed; }
    .card { max-width:480px; margin:3rem auto; padding:2rem; border-radius:16px; border:1px solid #2a2f3a; background:#161922; text-align:center; }
    h1 { font-size:1.4rem; font-weight:600; margin:0 0 0.75rem; }
    p { margin:0; line-height:1.6; opacity:0.85; }
    .ok { width:56px; height:56px; margin:0 auto 1.25rem; border-radius:50%; background:rgba(34,197,94,.15); display:flex; align-items:center; justify-content:center; font-size:1.75rem; }
    .foot { margin-top:1.75rem; font-size:.875rem; opacity:.55; }
    a { color:#93c5fd; }
  </style>
</head>
<body>
  <main class="card">
    ${ok ? `<div class="ok" aria-hidden="true">✓</div>` : ""}
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(body)}</p>
    <p class="foot">Questions? <a href="mailto:support@devjewels.com">Contact DevJewels</a></p>
  </main>
</body>
</html>`;
}