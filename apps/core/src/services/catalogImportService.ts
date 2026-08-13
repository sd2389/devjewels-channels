/**
 * Catalog import orchestration:
 * create catalog_import job → page Django designs → fetch inventory →
 * adapter.createProduct or updateProduct → product/variant mappings → progress + sync_log.
 *
 * Concurrency is capped (no unbounded fan-out).
 */
import { AdapterRouter } from "@/channels/router";
import { NotImplementedError } from "@/channels/types";
import { getConnectionById } from "@/services/connections";
import {
  getCatalogImportStore,
  type CatalogImportRow,
} from "@/services/catalogImportStore";
import { deverpClient } from "@/integrations/deverp/client";
import {
  getProductMappingStore,
  upsertProductMapping,
} from "@/services/productMappings";
import { getVariantMappingStore } from "@/services/variantMappings";
import { writeSyncLog } from "@/services/syncLog";

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_CONCURRENCY = 3;

export type RunCatalogImportOptions = {
  connectionId: string;
  /** Max designs processed in one run (safety cap). */
  maxDesigns?: number;
  pageSize?: number;
  concurrency?: number;
  /** Pre-created job id; if omitted a new pending job is created. */
  importId?: string;
};

export type CatalogImportResult = {
  importId: string;
  status: CatalogImportRow["status"];
  processed: number;
  failed: number;
  skipped: number;
  totalDesigns: number;
};

function parsePrice(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? "0"));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Simple promise pool — at most `limit` tasks in flight. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function collectEligibleDesigns(
  customerId: number,
  pageSize: number,
  maxDesigns: number,
): Promise<Array<{ designNo: string; title: string; totamt?: string }>> {
  const out: Array<{ designNo: string; title: string; totamt?: string }> = [];
  let afterId: number | null = null;
  while (out.length < maxDesigns) {
    const page = await deverpClient.listCatalogDesigns({
      customerId,
      limit: Math.min(pageSize, maxDesigns - out.length),
      afterId,
    });
    for (const item of page.items) {
      const designNo = String(item.design_no || "").trim();
      if (!designNo) continue;
      out.push({
        designNo,
        title: String(item.titleline || designNo).trim() || designNo,
        totamt: item.totamt != null ? String(item.totamt) : undefined,
      });
      if (out.length >= maxDesigns) break;
    }
    if (!page.has_more || page.next_after_id == null) break;
    afterId = page.next_after_id;
  }
  return out;
}

async function importOneDesign(input: {
  connectionId: string;
  platform: "SHOPIFY" | "WOOCOMMERCE" | "MAGENTO";
  credentialsSecretRef: string | null;
  designNo: string;
  title: string;
  defaultPrice: number;
}): Promise<"ok" | "skipped" | "failed"> {
  const inventory = await deverpClient.getInventory(input.designNo);
  const jobs = (inventory.jobs || []).filter((j) => String(j.job_no || "").trim());
  if (jobs.length === 0) {
    await writeSyncLog({
      connectionId: input.connectionId,
      platform: input.platform,
      jobType: "product",
      status: "SKIPPED",
      designNo: input.designNo,
      message: "no_live_jobs",
    });
    return "skipped";
  }

  const variants = jobs.map((j) => ({
    jobNo: String(j.job_no).trim(),
    sku: String(j.job_no).trim(),
    price: parsePrice(j.totamt ?? input.defaultPrice),
    quantity: 1,
  }));

  const adapter = AdapterRouter.get(input.platform);
  const mappingStore = getProductMappingStore();
  const existing = await mappingStore.getByDesign(input.connectionId, input.designNo);
  const variantStore = getVariantMappingStore();

  try {
    let result;
    if (existing?.external_product_id) {
      const existingVariants = [];
      for (const v of variants) {
        const mapped = await variantStore.getByDesignJob(
          input.connectionId,
          input.designNo,
          v.jobNo,
        );
        if (mapped) {
          existingVariants.push({
            jobNo: v.jobNo,
            externalVariantId: mapped.external_variant_id,
            externalInventoryItemId: mapped.external_inventory_item_id ?? undefined,
          });
        }
      }
      result = await adapter.updateProduct({
        connectionId: input.connectionId,
        designNo: input.designNo,
        title: input.title,
        credentialsSecretRef: input.credentialsSecretRef ?? undefined,
        externalProductId: existing.external_product_id,
        variants,
        existingVariants,
      });
    } else {
      result = await adapter.createProduct({
        connectionId: input.connectionId,
        designNo: input.designNo,
        title: input.title,
        credentialsSecretRef: input.credentialsSecretRef ?? undefined,
        variants,
      });
    }

    await upsertProductMapping({
      connectionId: input.connectionId,
      designNo: input.designNo,
      externalProductId: result.externalProductId,
    });

    for (const variant of result.variants) {
      await variantStore.upsert({
        connectionId: input.connectionId,
        designNo: input.designNo,
        jobNo: variant.jobNo,
        externalVariantId: variant.externalVariantId,
        externalInventoryItemId: variant.externalInventoryItemId ?? null,
      });
    }

    await writeSyncLog({
      connectionId: input.connectionId,
      platform: input.platform,
      jobType: "product",
      status: "SUCCESS",
      designNo: input.designNo,
      message: `${existing ? "updated" : "created"} variants=${result.variants.length}`,
    });
    return "ok";
  } catch (err) {
    if (err instanceof NotImplementedError) {
      await writeSyncLog({
        connectionId: input.connectionId,
        platform: input.platform,
        jobType: "product",
        status: "SKIPPED",
        designNo: input.designNo,
        message: "not_implemented",
      });
      return "skipped";
    }
    const message =
      err instanceof Error
        ? err.message.replace(/shpat_[a-zA-Z0-9]+/g, "shpat_***").slice(0, 500)
        : "unknown_error";
    await writeSyncLog({
      connectionId: input.connectionId,
      platform: input.platform,
      jobType: "product",
      status: "FAILED",
      designNo: input.designNo,
      message,
    });
    return "failed";
  }
}

/**
 * Create a pending catalog_import row for a connection (API / CLI entry).
 */
export async function createCatalogImportJob(
  connectionId: string,
): Promise<CatalogImportRow> {
  const connection = await getConnectionById(connectionId);
  if (!connection) {
    throw new Error("connection_not_found");
  }
  if (!connection.is_active) {
    throw new Error("connection_inactive");
  }
  return getCatalogImportStore().create(connectionId);
}

/**
 * Run catalog import for a connection (bounded concurrency + progress fields).
 */
export async function runCatalogImport(
  options: RunCatalogImportOptions,
): Promise<CatalogImportResult> {
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, 8),
  );
  const pageSize = Math.max(1, Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, 100));
  const maxDesigns = Math.max(1, Math.min(options.maxDesigns ?? 500, 5000));

  const connection = await getConnectionById(options.connectionId);
  if (!connection) {
    throw new Error("connection_not_found");
  }
  if (!connection.is_active) {
    throw new Error("connection_inactive");
  }
  if (connection.customer_id == null) {
    throw new Error("connection_missing_customer_id");
  }

  // No active API key / can_view_designs → empty import (entitlement SoT).
  const { requireSyncableEntitlements } = await import("@/services/entitlements");
  const entitlements = await requireSyncableEntitlements(connection.customer_id);
  if (!entitlements) {
    throw new Error(
      "Customer has no active API key with can_view_designs — connect requires a Customer API key",
    );
  }

  const store = getCatalogImportStore();
  const job =
    options.importId != null
      ? await store.getById(options.importId)
      : await store.create(options.connectionId);
  if (!job) {
    throw new Error("catalog_import_not_found");
  }

  const designs = await collectEligibleDesigns(
    connection.customer_id,
    pageSize,
    maxDesigns,
  );
  await store.markRunning(job.id, designs.length);

  let failed = 0;
  let skipped = 0;
  let processed = 0;

  await mapPool(designs, concurrency, async (design) => {
    const outcome = await importOneDesign({
      connectionId: connection.id,
      platform: connection.platform,
      credentialsSecretRef: connection.credentials_secret_ref,
      designNo: design.designNo,
      title: design.title,
      defaultPrice: parsePrice(design.totamt),
    });
    if (outcome === "failed") failed += 1;
    else if (outcome === "skipped") skipped += 1;
    else processed += 1;
    await store.bumpProcessed(job.id, 1);
  });

  if (failed > 0 && processed === 0 && skipped === 0) {
    await store.markFailed(job.id, `All ${failed} designs failed`);
    return {
      importId: job.id,
      status: "failed",
      processed,
      failed,
      skipped,
      totalDesigns: designs.length,
    };
  }

  await store.markCompleted(job.id);
  return {
    importId: job.id,
    status: "completed",
    processed,
    failed,
    skipped,
    totalDesigns: designs.length,
  };
}
