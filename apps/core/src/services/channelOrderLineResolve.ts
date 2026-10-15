/**
 * Resolve Shopify (etc.) line items to DevJewels design_no + job_no.
 *
 * Synced products store design_no on metafields, not checkout properties.
 * Real webhooks usually have SKU (= job_no) and variant_id — map those via
 * variant_mapping. Unmapped lines (merchant's own SKUs) are skipped.
 */
import type { NormalizedChannelOrder } from "@/channels/types";
import { getVariantMappingStore } from "@/services/variantMappings";

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

function toVariantGid(line: Record<string, unknown>): string {
  const admin = String(line.admin_graphql_api_id || "").trim();
  if (admin.startsWith("gid://shopify/ProductVariant/")) return admin;
  const variantId = String(line.variant_id ?? "").trim();
  if (variantId.startsWith("gid://")) return variantId;
  if (variantId && /^\d+$/.test(variantId)) {
    return `gid://shopify/ProductVariant/${variantId}`;
  }
  return "";
}

export type ResolvedChannelOrderLine = {
  designNo: string;
  jobNo: string;
  quantity: number;
  externalLineId?: string;
};

/**
 * Prefer explicit properties; else variant_mapping by variant id / SKU(job_no).
 * Returns only DevJewels-mapped lines (mixed carts stay valid).
 */
export async function resolveChannelOrderLines(input: {
  connectionId: string;
  payload: unknown;
}): Promise<{
  lines: ResolvedChannelOrderLine[];
  skippedUnmapped: number;
}> {
  const order = asRecord(input.payload);
  if (!order) {
    throw new Error("Order payload must be an object");
  }
  const rawLines = Array.isArray(order.line_items) ? order.line_items : [];
  const store = getVariantMappingStore();
  const lines: ResolvedChannelOrderLine[] = [];
  let skippedUnmapped = 0;

  for (const raw of rawLines) {
    const line = asRecord(raw);
    if (!line) continue;

    const props = propMap(line.properties);
    let designNo =
      props["design_no"] ||
      props["designno"] ||
      props["_design_no"] ||
      String(line.design_no || "").trim();
    let jobNo =
      props["job_no"] ||
      props["jobno"] ||
      props["_job_no"] ||
      String(line.sku || "").trim();

    if (!designNo || !jobNo) {
      const variantGid = toVariantGid(line);
      if (variantGid) {
        const byVariant = await store.getByExternalVariantId(
          input.connectionId,
          variantGid,
        );
        if (byVariant) {
          designNo = byVariant.design_no;
          jobNo = byVariant.job_no;
        }
      }
    }

    if ((!designNo || !jobNo) && String(line.sku || "").trim()) {
      const sku = String(line.sku).trim();
      const byJob = await store.getByJobNo(input.connectionId, sku);
      if (byJob) {
        designNo = byJob.design_no;
        jobNo = byJob.job_no;
      }
    }

    if (!designNo || !jobNo) {
      skippedUnmapped += 1;
      continue;
    }

    const qty = Number.parseInt(String(line.quantity ?? "1"), 10);
    lines.push({
      designNo,
      jobNo,
      quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
      externalLineId: String(line.id ?? "").trim() || undefined,
    });
  }

  return { lines, skippedUnmapped };
}

/** Apply resolved lines onto a normalized order shell (platform / ids / email). */
export function applyResolvedLines(
  order: NormalizedChannelOrder,
  lines: ResolvedChannelOrderLine[],
): NormalizedChannelOrder {
  return {
    ...order,
    lines: lines.map((line) => ({
      designNo: line.designNo,
      jobNo: line.jobNo,
      quantity: line.quantity,
      externalLineId: line.externalLineId,
    })),
  };
}
