import { assertAdminRequest, jsonError } from "@/security/dashboardAuth";
import {
  getConnectionDetail,
  importCatalogForConnection,
  setShopifyPrimaryLocation,
} from "@/services/connectShopifyService";
import {
  listDesignMarkups,
  replaceDesignMarkups,
  type DesignMarkupInput,
} from "@/services/connectionDesignMarkups";
import { updateConnectionMarkup } from "@/services/connections";
import type { MarkupMode } from "@/services/markup";

type Ctx = { params: Promise<{ id: string }> };

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

export async function GET(req: Request, ctx: Ctx) {
  try {
    await assertAdminRequest(req);
    const { id } = await ctx.params;
    const detail = await getConnectionDetail(id);
    if (!detail) {
      return Response.json({ error: "Connection not found" }, { status: 404 });
    }
    const designMarkups = await listDesignMarkups(id);
    return Response.json({
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
      designMarkups?: unknown;
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
      const mode = parseMarkupMode(body.markupMode ?? "none");
      if (!mode) {
        return Response.json({ error: "Invalid markup_mode" }, { status: 400 });
      }
      const value = Number(body.markupValue ?? 0);
      if (!Number.isFinite(value) || value < 0) {
        return Response.json({ error: "markup_value must be >= 0" }, { status: 400 });
      }
      if (mode === "multiplier" && value <= 0) {
        return Response.json(
          { error: "multiplier markup_value must be > 0" },
          { status: 400 },
        );
      }

      const hasDesignMarkups = Object.prototype.hasOwnProperty.call(
        body,
        "designMarkups",
      );
      let designRows: DesignMarkupInput[] | undefined;
      if (hasDesignMarkups) {
        const parsed = parseDesignMarkups(body.designMarkups);
        if ("error" in parsed) {
          return Response.json({ error: parsed.error }, { status: 400 });
        }
        designRows = parsed;
      }

      const updated = await updateConnectionMarkup(id, {
        markupMode: mode,
        markupValue: value,
      });
      if (!updated) {
        return Response.json({ error: "Connection not found" }, { status: 404 });
      }

      const designMarkups =
        designRows !== undefined
          ? await replaceDesignMarkups(id, designRows)
          : await listDesignMarkups(id);

      return Response.json({
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
