import { assertAdminRequest, jsonError } from "@/security/dashboardAuth";
import {
  getConnectionDetail,
  importCatalogForConnection,
  setShopifyPrimaryLocation,
} from "@/services/connectShopifyService";
import { updateConnectionMarkup } from "@/services/connections";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    await assertAdminRequest(req);
    const { id } = await ctx.params;
    const detail = await getConnectionDetail(id);
    if (!detail) {
      return Response.json({ error: "Connection not found" }, { status: 404 });
    }
    return Response.json({
      connection: detail.connection,
      shop_domain: detail.shopDomain,
      locations: detail.locations,
    });
  } catch (err) {
    return jsonError(err);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    await assertAdminRequest(req);
    const { id } = await ctx.params;
    const body = (await req.json()) as {
      action?: string;
      externalLocationId?: string;
      maxDesigns?: number;
      markupMode?: "none" | "percent" | "multiplier";
      markupValue?: number;
    };
    const action = body.action || "";

    if (action === "set_location") {
      const loc = await setShopifyPrimaryLocation(
        id,
        String(body.externalLocationId || ""),
      );
      return Response.json({ location: loc });
    }

    if (action === "import_catalog") {
      const result = await importCatalogForConnection(
        id,
        typeof body.maxDesigns === "number" ? body.maxDesigns : 50,
      );
      return Response.json({ import: result });
    }

    if (action === "set_markup") {
      const mode = body.markupMode || "none";
      if (mode !== "none" && mode !== "percent" && mode !== "multiplier") {
        return Response.json({ error: "Invalid markup_mode" }, { status: 400 });
      }
      const value = Number(body.markupValue ?? 0);
      if (!Number.isFinite(value) || value < 0) {
        return Response.json({ error: "markup_value must be >= 0" }, { status: 400 });
      }
      const updated = await updateConnectionMarkup(id, {
        markupMode: mode,
        markupValue: value,
      });
      if (!updated) {
        return Response.json({ error: "Connection not found" }, { status: 404 });
      }
      return Response.json({
        connection: {
          id: updated.id,
          markup_mode: updated.markup_mode,
          markup_value: updated.markup_value,
        },
      });
    }

    return Response.json(
      {
        error:
          "Unknown action (use set_location, import_catalog, or set_markup)",
      },
      { status: 400 },
    );
  } catch (err) {
    return jsonError(err);
  }
}
