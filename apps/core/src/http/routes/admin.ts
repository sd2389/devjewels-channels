import { assertAdminRequest, jsonError } from "@/security/dashboardAuth";
import {
  connectShopifyStore,
  getConnectionDetail,
  importCatalogForConnection,
  listConnectionDetails,
  setShopifyPrimaryLocation,
} from "@/services/connectShopifyService";
import {
  getShopifyOAuthPublicStatus,
  parseShopifyOAuthAppCredentials,
  saveShopifyOAuthAppCredentials,
} from "@devjewels-channels/shopify/auth";
import { listChannelsCustomers } from "@/integrations/deverp/client";
import {
  listDesignMarkups,
  replaceDesignMarkups,
  type DesignMarkupInput,
} from "@/services/connectionDesignMarkups";
import { updateConnectionMarkup } from "@/services/connections";
import type { MarkupMode } from "@/services/markup";
import { json } from "../response";

const Q_MAX_LEN = 100;

export async function getAdminConnections(req: Request): Promise<Response> {
  try {
    await assertAdminRequest(req);
    const connections = await listConnectionDetails();
    return json({
      connections: connections.map((c) => ({
        id: c.connection.id,
        name: c.connection.name,
        platform: c.connection.platform,
        is_active: c.connection.is_active,
        customer_id: c.connection.customer_id,
        markup_mode: c.connection.markup_mode,
        markup_value: c.connection.markup_value,
        sync_inventory: c.connection.sync_inventory,
        sync_products: c.connection.sync_products,
        shop_domain: c.shopDomain,
        locations: c.locations,
        primary_location_id:
          c.locations.find((l) => l.is_primary)?.external_location_id ?? null,
      })),
    });
  } catch (err) {
    return jsonError(err);
  }
}

export async function getAdminShopifyOauthConfig(req: Request): Promise<Response> {
  try {
    await assertAdminRequest(req);
    return json(await getShopifyOAuthPublicStatus());
  } catch (err) {
    return jsonError(err);
  }
}

export async function postAdminShopifyOauthConfig(req: Request): Promise<Response> {
  try {
    await assertAdminRequest(req);
    const body: unknown = await req.json();
    const parsed = parseShopifyOAuthAppCredentials(body);
    const status = await saveShopifyOAuthAppCredentials(parsed);
    return json(status);
  } catch (err) {
    return jsonError(err);
  }
}

export async function getAdminCustomers(req: Request): Promise<Response> {
  try {
    await assertAdminRequest(req);
    const url = new URL(req.url);
    const q = url.searchParams.get("q") ?? "";
    if (q.length > Q_MAX_LEN) {
      return json({ error: "Query is too long." }, 400);
    }
    const offsetRaw = url.searchParams.get("offset");
    const offset = offsetRaw ? Number(offsetRaw) : 0;
    const data = await listChannelsCustomers({
      q,
      limit: 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    return json(data);
  } catch (err) {
    return jsonError(err);
  }
}

export async function postAdminConnectionsShopify(req: Request): Promise<Response> {
  try {
    await assertAdminRequest(req);
    const body = (await req.json()) as {
      name?: string;
      shopDomain?: string;
      accessToken?: string;
      webhookSecret?: string;
      customerId?: number;
      markupMode?: "none" | "percent" | "multiplier";
      markupValue?: number;
    };
    const customerId = Number(body.customerId);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return json(
        { error: "customer_id is required (DevJewels Customer.pk)" },
        400,
      );
    }
    const result = await connectShopifyStore({
      name: body.name,
      shopDomain: String(body.shopDomain || ""),
      accessToken: String(body.accessToken || ""),
      webhookSecret: body.webhookSecret,
      customerId,
      markupMode: body.markupMode,
      markupValue: body.markupValue,
    });
    return json(
      {
        connection: {
          id: result.connection.id,
          name: result.connection.name,
          platform: result.connection.platform,
          is_active: result.connection.is_active,
          customer_id: result.connection.customer_id,
          markup_mode: result.connection.markup_mode,
          markup_value: result.connection.markup_value,
          sync_inventory: result.connection.sync_inventory,
          sync_products: result.connection.sync_products,
        },
        shop_domain: result.shopDomain,
        locations: result.locations,
        reconnected: result.reconnected,
        webhooks_registered: result.webhooks.length,
      },
      result.reconnected ? 200 : 201,
    );
  } catch (err) {
    return jsonError(err);
  }
}

function parseMarkupMode(raw: unknown): MarkupMode | null {
  const mode = String(raw || "none").trim().toLowerCase();
  if (mode === "none" || mode === "percent" || mode === "multiplier") return mode;
  return null;
}

function parseDesignMarkups(raw: unknown): DesignMarkupInput[] | { error: string } {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    return { error: "designMarkups must be an array" };
  }
  const out: DesignMarkupInput[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      return { error: "Each designMarkup must be an object" };
    }
    const row = item as {
      designNo?: unknown;
      markupMode?: unknown;
      markupValue?: unknown;
    };
    const designNo = String(row.designNo ?? "").trim();
    if (!designNo) {
      return { error: "designNo is required for each design markup" };
    }
    const key = designNo.replace(/\s+/g, "").toUpperCase();
    if (seen.has(key)) {
      return { error: `Duplicate designNo: ${designNo}` };
    }
    seen.add(key);
    const mode = parseMarkupMode(row.markupMode);
    if (!mode) {
      return { error: "Invalid markup_mode in designMarkups" };
    }
    const value = Number(row.markupValue ?? 0);
    if (!Number.isFinite(value) || value < 0) {
      return { error: "design markup_value must be >= 0" };
    }
    if (mode === "multiplier" && value <= 0) {
      return { error: "multiplier markup_value must be > 0" };
    }
    out.push({ designNo, markupMode: mode, markupValue: value });
  }
  return out;
}

export async function getAdminConnectionById(
  req: Request,
  id: string,
): Promise<Response> {
  try {
    await assertAdminRequest(req);
    const detail = await getConnectionDetail(id);
    if (!detail) {
      return json({ error: "Connection not found" }, 404);
    }
    const designMarkups = await listDesignMarkups(id);
    return json({
      connection: detail.connection,
      shop_domain: detail.shopDomain,
      locations: detail.locations,
      design_markups: designMarkups.map((r) => ({
        design_no: r.design_no,
        markup_mode: r.markup_mode,
        markup_value: r.markup_value,
      })),
    });
  } catch (err) {
    return jsonError(err);
  }
}

export async function postAdminConnectionById(
  req: Request,
  id: string,
): Promise<Response> {
  try {
    await assertAdminRequest(req);
    const body = (await req.json()) as {
      action?: string;
      externalLocationId?: string;
      maxDesigns?: number;
      markupMode?: "none" | "percent" | "multiplier";
      markupValue?: number;
      designMarkups?: unknown;
    };
    const action = body.action || "";

    if (action === "set_location") {
      const loc = await setShopifyPrimaryLocation(
        id,
        String(body.externalLocationId || ""),
      );
      return json({ location: loc });
    }

    if (action === "import_catalog") {
      const result = await importCatalogForConnection(
        id,
        typeof body.maxDesigns === "number" ? body.maxDesigns : 50,
      );
      return json({ import: result });
    }

    if (action === "set_markup") {
      const mode = parseMarkupMode(body.markupMode ?? "none");
      if (!mode) {
        return json({ error: "Invalid markup_mode" }, 400);
      }
      const value = Number(body.markupValue ?? 0);
      if (!Number.isFinite(value) || value < 0) {
        return json({ error: "markup_value must be >= 0" }, 400);
      }
      if (mode === "multiplier" && value <= 0) {
        return json({ error: "multiplier markup_value must be > 0" }, 400);
      }

      const hasDesignMarkups = Object.prototype.hasOwnProperty.call(
        body,
        "designMarkups",
      );
      let designRows: DesignMarkupInput[] | undefined;
      if (hasDesignMarkups) {
        const parsed = parseDesignMarkups(body.designMarkups);
        if ("error" in parsed) {
          return json({ error: parsed.error }, 400);
        }
        designRows = parsed;
      }

      const updated = await updateConnectionMarkup(id, {
        markupMode: mode,
        markupValue: value,
      });
      if (!updated) {
        return json({ error: "Connection not found" }, 404);
      }

      const designMarkups =
        designRows !== undefined
          ? await replaceDesignMarkups(id, designRows)
          : await listDesignMarkups(id);

      return json({
        connection: {
          id: updated.id,
          markup_mode: updated.markup_mode,
          markup_value: updated.markup_value,
        },
        design_markups: designMarkups.map((r) => ({
          design_no: r.design_no,
          markup_mode: r.markup_mode,
          markup_value: r.markup_value,
        })),
      });
    }

    return json(
      {
        error:
          "Unknown action (use set_location, import_catalog, or set_markup)",
      },
      400,
    );
  } catch (err) {
    return jsonError(err);
  }
}

export async function postWoocommerceWebhooks(): Promise<Response> {
  return json(
    {
      accepted: false,
      message: "WooCommerce webhooks — Phase 3 stub",
    },
    501,
  );
}
