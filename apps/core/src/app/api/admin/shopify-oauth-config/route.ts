import { assertAdminRequest, jsonError } from "@/security/dashboardAuth";
import {
  getShopifyOAuthPublicStatus,
  parseShopifyOAuthAppCredentials,
  saveShopifyOAuthAppCredentials,
} from "@devjewels-channels/shopify/auth";

/** GET /api/admin/shopify-oauth-config — { configured, apiKeyLast4 }; never returns the secret. */
export async function GET(req: Request) {
  try {
    await assertAdminRequest(req);
    return Response.json(await getShopifyOAuthPublicStatus());
  } catch (err) {
    return jsonError(err);
  }
}

/** POST /api/admin/shopify-oauth-config — save Partner Client ID + Secret to vault. */
export async function POST(req: Request) {
  try {
    await assertAdminRequest(req);
    const body: unknown = await req.json();
    const parsed = parseShopifyOAuthAppCredentials(body);
    const status = await saveShopifyOAuthAppCredentials(parsed);
    return Response.json(status);
  } catch (err) {
    return jsonError(err);
  }
}
