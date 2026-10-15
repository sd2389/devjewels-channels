/**
 * Shopify order payload → NormalizedChannelOrder.
 *
 * Line identity: properties when present; otherwise SKU (= job_no) and variant_id.
 * Full design_no+job_no resolution (via variant_mapping) runs in Channels core
 * before Django reserve — synced products put design_no on metafields, not line props.
 */
import type { NormalizedChannelOrder } from "@devjewels-channels/core/channels/types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function propMap(properties: unknown): Record<string, string> {
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
    String(line.sku || "").trim();

  // Properties path: both required. SKU-only is resolved later via variant_mapping.
  if (designNo && jobNo) return { designNo, jobNo };
  return null;
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
    if (!keys) continue;
    const qty = Number.parseInt(String(line.quantity ?? "1"), 10);
    lines.push({
      designNo: keys.designNo,
      jobNo: keys.jobNo,
      quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
      externalLineId: String(line.id ?? "").trim() || undefined,
    });
  }

  // Empty lines OK here — orderProcessingService fills from variant_mapping.
  return {
    connectionId,
    platform: "SHOPIFY",
    externalOrderId,
    currency,
    customerEmail: email,
    lines,
  };
}
