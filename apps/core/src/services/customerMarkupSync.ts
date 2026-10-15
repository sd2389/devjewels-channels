/**
 * Customer self-serve design markup → Channels DB + product.sync fan-out.
 * Django calls POST /api/internal/customer-markup after validating entitlement.
 */
import { listConnectionsByCustomerId } from "@/services/connections";
import {
  getConnectionDesignMarkupStore,
  normalizeDesignNoKey,
  type DesignMarkupInput,
} from "@/services/connectionDesignMarkups";
import type { MarkupMode } from "@/services/markup";
import { enqueueProductSync } from "@/services/queue";
import type { ProductSyncJob } from "@/workers/handlers";

export type CustomerDesignMarkupInput = {
  designNo: string;
  markupMode: MarkupMode;
  markupValue: number;
};

export type ApplyCustomerDesignMarkupsResult = {
  customer_id: number;
  connections_touched: number;
  designs_upserted: number;
  designs_cleared: number;
  sync_enqueued: number;
  transport: "sqs" | "memory" | "none";
};

function normalizeMode(raw: unknown): MarkupMode {
  const mode = String(raw || "none").trim().toLowerCase();
  if (mode === "percent" || mode === "multiplier") return mode;
  return "none";
}

function parseMarkupRows(raw: unknown): CustomerDesignMarkupInput[] {
  if (!Array.isArray(raw)) {
    throw new Error("design_markups must be an array");
  }
  if (raw.length === 0) {
    throw new Error("design_markups must not be empty");
  }
  if (raw.length > 500) {
    throw new Error("At most 500 design markups are allowed");
  }

  const seen = new Set<string>();
  const out: CustomerDesignMarkupInput[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Each design_markups entry must be an object");
    }
    const row = entry as Record<string, unknown>;
    const designNo = normalizeDesignNoKey(String(row.designNo ?? row.design_no ?? ""));
    if (!designNo) {
      throw new Error("designNo is required");
    }
    if (seen.has(designNo)) {
      throw new Error(`Duplicate designNo: ${designNo}`);
    }
    seen.add(designNo);

    const markupMode = normalizeMode(row.markupMode ?? row.markup_mode);
    const markupValue = Number(row.markupValue ?? row.markup_value ?? 0);
    if (!Number.isFinite(markupValue) || markupValue < 0) {
      throw new Error(`Invalid markupValue for ${designNo}`);
    }
    if (markupMode === "multiplier" && markupValue <= 0) {
      throw new Error(`Multiplier markup for ${designNo} must be > 0`);
    }

    out.push({ designNo, markupMode, markupValue });
  }
  return out;
}

/**
 * Upsert/clear per-design markups on every connection for the customer,
 * then enqueue product.sync for active sync_products shops.
 */
export async function applyCustomerDesignMarkupsAndSync(input: {
  customerId: number;
  designMarkups: unknown;
  sync?: boolean;
}): Promise<ApplyCustomerDesignMarkupsResult> {
  const customerId = Number(input.customerId);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    throw new Error("customer_id must be a positive integer");
  }

  const rows = parseMarkupRows(input.designMarkups);
  const sync = input.sync !== false;
  const connections = await listConnectionsByCustomerId(customerId);
  const store = getConnectionDesignMarkupStore();

  let designsUpserted = 0;
  let designsCleared = 0;

  for (const connection of connections) {
    for (const row of rows) {
      if (row.markupMode === "none") {
        const deleted = await store.deleteByDesign(connection.id, row.designNo);
        if (deleted) designsCleared += 1;
        continue;
      }
      const payload: DesignMarkupInput = {
        designNo: row.designNo,
        markupMode: row.markupMode,
        markupValue: row.markupValue,
      };
      await store.upsert(connection.id, payload);
      designsUpserted += 1;
    }
  }

  let syncEnqueued = 0;
  let transport: "sqs" | "memory" | "none" = "none";

  if (sync && rows.length > 0) {
    const jobs: ProductSyncJob[] = connections
      .filter((connection) => connection.is_active && connection.sync_products)
      .flatMap((connection) =>
        rows.map((row) => ({
          kind: "product.sync" as const,
          connectionId: connection.id,
          platform: connection.platform,
          designNo: row.designNo,
          action: "sync" as const,
        })),
      );

    for (const job of jobs) {
      const result = await enqueueProductSync(job);
      syncEnqueued += 1;
      transport = result.transport;
    }
  }

  console.info("customer_markup_applied", {
    customer_id: customerId,
    connections_touched: connections.length,
    designs_upserted: designsUpserted,
    designs_cleared: designsCleared,
    sync_enqueued: syncEnqueued,
    transport,
  });

  return {
    customer_id: customerId,
    connections_touched: connections.length,
    designs_upserted: designsUpserted,
    designs_cleared: designsCleared,
    sync_enqueued: syncEnqueued,
    transport,
  };
}
