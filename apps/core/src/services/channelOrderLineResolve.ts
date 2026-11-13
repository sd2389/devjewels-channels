/**
 * Resolve Shopify (etc.) line items to DevJewels design_no + job_no.
 *
 * Synced products store design_no on metafields, not checkout properties.
 * Real webhooks usually have SKU (= job_no) and variant_id — map those via
 * variant_mapping. A Metal × Size variant (variant_slot) resolves to its
 * cheapest live pieces instead. Unmapped lines (merchant's own SKUs) are skipped.
 */
import type { NormalizedChannelOrder } from "@/channels/types";
import { getVariantMappingStore } from "@/services/variantMappings";
import { getVariantSlotStore } from "@/services/variantSlots";
import { storeApiClient } from "@/integrations/storeApi/client";

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

/**
 * Pieces for one Metal × Size line: the slot's pieces still live, cheapest
 * first, skipping any piece an earlier line of this order already took.
 *
 * Short of live pieces it tops up from the slot's last-known pieces instead of
 * failing here: a repeat webhook (orders/updated, orders/paid) of an order
 * already reserved finds its piece gone from the live feed, and Django answers
 * that with "duplicate"; a piece truly sold elsewhere gets Django's 409.
 */
export function pickSlotPieces(input: {
  slotJobNos: string[];
  liveJobNos: ReadonlySet<string>;
  taken: Set<string>;
  quantity: number;
}): string[] {
  const free = input.slotJobNos
    .map((j) => j.trim())
    .filter((j) => j && !input.taken.has(j.toUpperCase()));
  const live = free.filter((j) => input.liveJobNos.has(j.toUpperCase()));
  const stale = free.filter((j) => !input.liveJobNos.has(j.toUpperCase()));
  const picked = [...live, ...stale].slice(0, input.quantity);
  for (const j of picked) input.taken.add(j.toUpperCase());
  return picked;
}

export type SlotShortfall = {
  designNo: string;
  sku: string;
  wanted: number;
  found: number;
};

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
  /** Metal × Size store: variants name a slot, resolved to its cheapest live piece. */
  metalSizeLayout?: boolean;
}): Promise<{
  lines: ResolvedChannelOrderLine[];
  skippedUnmapped: number;
  /** Metal × Size lines with fewer pieces than were bought. Non-empty → do not reserve. */
  slotShortfalls: SlotShortfall[];
}> {
  const order = asRecord(input.payload);
  if (!order) {
    throw new Error("Order payload must be an object");
  }
  const rawLines = Array.isArray(order.line_items) ? order.line_items : [];
  const store = getVariantMappingStore();
  const slotStore = input.metalSizeLayout ? getVariantSlotStore() : null;
  const lines: ResolvedChannelOrderLine[] = [];
  let skippedUnmapped = 0;
  const slotShortfalls: SlotShortfall[] = [];
  const taken = new Set<string>();
  const liveByDesign = new Map<string, Promise<Set<string>>>();
  const liveJobs = (designNo: string) => {
    const key = designNo.replace(/\s+/g, "").toUpperCase();
    let cached = liveByDesign.get(key);
    if (!cached) {
      cached = storeApiClient
        .getInventory(designNo)
        .then((inv) => new Set(inv.jobs.map((j) => String(j.job_no || "").trim().toUpperCase())));
      liveByDesign.set(key, cached);
    }
    return cached;
  };

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

    const qty = Number.parseInt(String(line.quantity ?? "1"), 10);
    const quantity = Number.isFinite(qty) && qty > 0 ? qty : 1;

    // Metal × Size variant: the SKU names the slot, not a piece.
    const explicitPiece = Boolean(props["design_no"] || props["designno"] || props["_design_no"]);
    if (slotStore && !explicitPiece) {
      const variantGid = toVariantGid(line);
      const slot =
        (variantGid ? await slotStore.getByExternalVariantId(input.connectionId, variantGid) : null) ??
        (String(line.sku || "").trim()
          ? await slotStore.getBySku(input.connectionId, String(line.sku).trim())
          : null);
      if (slot) {
        const picked = pickSlotPieces({
          slotJobNos: slot.job_nos,
          liveJobNos: await liveJobs(slot.design_no),
          taken,
          quantity,
        });
        // Never reserve part of a line: fewer pieces than were bought fails the
        // whole order (the caller logs it and re-syncs the design).
        if (picked.length < quantity) {
          slotShortfalls.push({
            designNo: slot.design_no,
            sku: slot.sku,
            wanted: quantity,
            found: picked.length,
          });
          continue;
        }
        // Django reserves one piece per line, so each piece is its own line.
        for (const pieceJobNo of picked) {
          lines.push({
            designNo: slot.design_no,
            jobNo: pieceJobNo,
            quantity: 1,
            externalLineId: String(line.id ?? "").trim() || undefined,
          });
        }
        continue;
      }
    }

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

    lines.push({
      designNo,
      jobNo,
      quantity,
      externalLineId: String(line.id ?? "").trim() || undefined,
    });
  }

  return { lines, skippedUnmapped, slotShortfalls };
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
