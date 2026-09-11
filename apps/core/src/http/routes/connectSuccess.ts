import { html } from "../response";
import { renderConnectSuccessHtml } from "../connectSuccessPage";

/**
 * GET /connect/success — merchant confirmation (API Gateway has no Next.js pages).
 */
export async function getConnectSuccess(request: Request): Promise<Response> {
  const url = new URL(request.url);
  return html(
    renderConnectSuccessHtml({
      connected: url.searchParams.get("connected") === "1",
      reconnected: url.searchParams.get("reconnected") === "1",
      errorCode: url.searchParams.get("shopify_error"),
      installed: url.searchParams.get("installed") === "1",
    }),
  );
}
