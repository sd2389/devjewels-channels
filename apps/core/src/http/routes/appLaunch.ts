import { resolveShopifyAppLaunch } from "@/services/shopifyAppLaunchService";
import { renderConnectSuccessHtml } from "../connectSuccessPage";
import { html, json, redirectTo } from "../response";

function installedHtml(): Response {
  return html(
    renderConnectSuccessHtml({
      connected: false,
      reconnected: false,
      errorCode: null,
      installed: true,
    }),
  );
}

/**
 * GET / — Shopify application_url (hmac + shop) or merchant landing HTML.
 */
export async function getAppRoot(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let result;
  try {
    result = await resolveShopifyAppLaunch(url.searchParams);
  } catch (err) {
    console.error("shopify_app_launch_unhandled", {
      error_type: err instanceof Error ? err.name : "Error",
    });
    return installedHtml();
  }

  switch (result.kind) {
    case "home":
      return installedHtml();
    case "unauthorized":
      return json({ error: "Unauthorized" }, 401);
    case "oauth": {
      const qs = new URLSearchParams({
        shop: result.shop,
        customer_id: String(result.customerId),
        merchant: "1",
        client_id: result.clientId,
      });
      return redirectTo(request, `/api/shopify/auth?${qs.toString()}`);
    }
    case "connected":
      return redirectTo(request, "/connect/success?connected=1");
    case "oauth_not_configured":
      return redirectTo(request, "/connect/success?shopify_error=oauth_not_configured");
    case "finish_setup":
      return redirectTo(request, "/connect/success?installed=1");
  }
}
