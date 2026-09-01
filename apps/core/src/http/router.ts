import { postInternalEvents } from "./routes/internalEvents";
import { postShopifyWebhooks } from "./routes/shopifyWebhooks";
import {
  getShopifyAuthCallback,
  getShopifyAuthStart,
} from "./routes/shopifyAuth";
import {
  getAdminConnectionById,
  getAdminConnections,
  getAdminCustomers,
  getAdminShopifyOauthConfig,
  postAdminConnectionById,
  postAdminConnectionsShopify,
  postAdminShopifyInvites,
  postAdminShopifyOauthConfig,
  postWoocommerceWebhooks,
} from "./routes/admin";
import { getConnectShopify } from "./routes/shopifyConnect";
import { json } from "./response";

type RouteHandler = (req: Request, params: Record<string, string>) => Promise<Response>;

function match(
  method: string,
  path: string,
  pattern: string,
): Record<string, string> | null {
  const methodPart = pattern.split(" ")[0];
  const pathPart = pattern.split(" ").slice(1).join(" ");
  if (methodPart !== method && methodPart !== "ANY") return null;

  const patternSegs = pathPart.split("/").filter(Boolean);
  const pathSegs = path.split("/").filter(Boolean);
  if (patternSegs.length !== pathSegs.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegs.length; i++) {
    const p = patternSegs[i]!;
    const v = pathSegs[i]!;
    if (p.startsWith("{") && p.endsWith("}")) {
      params[p.slice(1, -1)] = decodeURIComponent(v);
    } else if (p !== v) {
      return null;
    }
  }
  return params;
}

const routes: Array<{ pattern: string; handle: RouteHandler }> = [
  {
    pattern: "GET /health",
    handle: async () => json({ ok: true, service: "devjewels-channels" }),
  },
  {
    pattern: "POST /api/internal/events",
    handle: async (req) => postInternalEvents(req),
  },
  {
    pattern: "POST /api/shopify/webhooks",
    handle: async (req) => postShopifyWebhooks(req),
  },
  {
    pattern: "GET /api/shopify/auth",
    handle: async (req) => getShopifyAuthStart(req),
  },
  {
    pattern: "GET /api/shopify/auth/callback",
    handle: async (req) => getShopifyAuthCallback(req),
  },
  {
    pattern: "GET /api/connect/shopify",
    handle: async (req) => getConnectShopify(req),
  },
  {
    pattern: "POST /api/woocommerce/webhooks",
    handle: async () => postWoocommerceWebhooks(),
  },
  {
    pattern: "GET /api/admin/connections",
    handle: async (req) => getAdminConnections(req),
  },
  {
    pattern: "GET /api/admin/connections/{id}",
    handle: async (req, params) => getAdminConnectionById(req, params.id!),
  },
  {
    pattern: "POST /api/admin/connections/{id}",
    handle: async (req, params) => postAdminConnectionById(req, params.id!),
  },
  {
    pattern: "POST /api/admin/connections/shopify",
    handle: async (req) => postAdminConnectionsShopify(req),
  },
  {
    pattern: "POST /api/admin/shopify-invites",
    handle: async (req) => postAdminShopifyInvites(req),
  },
  {
    pattern: "GET /api/admin/shopify-oauth-config",
    handle: async (req) => getAdminShopifyOauthConfig(req),
  },
  {
    pattern: "POST /api/admin/shopify-oauth-config",
    handle: async (req) => postAdminShopifyOauthConfig(req),
  },
  {
    pattern: "GET /api/admin/customers",
    handle: async (req) => getAdminCustomers(req),
  },
];

/** Dispatch a Fetch API Request to Channels HTTP routes. */
export async function dispatch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = url.pathname.replace(/\/+$/, "") || "/";

  // Prefer more specific paths (connections/shopify before connections/{id})
  const ordered = [...routes].sort(
    (a, b) => b.pattern.length - a.pattern.length,
  );

  for (const route of ordered) {
    const params = match(method, path, route.pattern);
    if (params) {
      return route.handle(request, params);
    }
  }

  return json({ error: "Not found", path, method }, 404);
}
