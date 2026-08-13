/**
 * Shopify order payload → NormalizedChannelOrder.
 *
 * Line identity: prefer metafield / SKU as job_no; design_no from properties or SKU prefix.
 * Channels must already have variant_mapping for reliable reverse lookup in later polish;
 * MVP accepts design_no + job_no via line_item properties / note_attributes / sku.
 */
import type { NormalizedChannelOrder } from "@devjewels-channels/core/channels/types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function propMap(
  properties: unknown,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(properties)) return out;
  for (const p of properties) {
    const row = asRecord(p);
    if (!row) continue;
    const name = String(row.name ?? row.key ?? "").trim().toLowerCase();
    const value = String(row.value ?? "").trim();
    if (name && value) out[name] = value;
  }
  return out;
}

function resolveDesignJob(line: Record<string, unknown>): {
  designNo: string;
  jobNo: string;
} | null {
  const props = propMap(line.properties);
  const designNo =
    props["design_no"] ||
    props["designno"] ||
    props["_design_no"] ||
    String(line.design_no || "").trim();
  const jobNo =
    props["job_no"] ||
    props["jobno"] ||
    props["_job_no"] ||
    String(line.sku || "").trim() ||
    String(line.variant_id || "").trim();

  if (!designNo || !jobNo) return null;
  return { designNo, jobNo };
}

export function normalizeShopifyOrder(
  payload: unknown,
  connectionId: string,
): NormalizedChannelOrder {
  const order = asRecord(payload);
  if (!order) {
    throw new Error("Shopify order payload must be an object");
  }

  const externalOrderId = String(
    order.admin_graphql_api_id || order.id || "",
  ).trim();
  if (!externalOrderId) {
    throw new Error("Shopify order missing id");
  }

  const currency = String(order.currency || order.presentment_currency || "USD").trim() || "USD";
  const email =
    String(order.email || order.contact_email || "").trim() || undefined;

  const rawLines = Array.isArray(order.line_items) ? order.line_items : [];
  const lines: NormalizedChannelOrder["lines"] = [];
  for (const raw of rawLines) {
    const line = asRecord(raw);
    if (!line) continue;
    const keys = resolveDesignJob(line);
    if (!keys) {
      throw new Error(
        "Shopify line_item missing design_no/job_no (set properties or sku)",
      );
    }
    const qty = Number.parseInt(String(line.quantity ?? "1"), 10);
    lines.push({
      designNo: keys.designNo,
      jobNo: keys.jobNo,
      quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
      externalLineId: String(line.id ?? "").trim() || undefined,
    });
  }

  if (!lines.length) {
    throw new Error("Shopify order has no resolvable line items");
  }

  return {
    connectionId,
    platform: "SHOPIFY",
    externalOrderId,
    currency,
    customerEmail: email,
    lines,
  };
}
