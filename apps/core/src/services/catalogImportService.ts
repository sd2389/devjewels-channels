/**
 * Catalog import orchestration:
 * create catalog_import job → page Django designs → fetch inventory →
 * adapter.createProduct or updateProduct → product/variant mappings → progress + sync_log.
 *
 * Concurrency is capped (no unbounded fan-out).
 */
import { registerDefaultAdapters } from "@/channels/registerAdapters";
import { AdapterRouter } from "@/channels/router";
import { NotImplementedError } from "@/channels/types";
import { getConnectionById } from "@/services/connections";
import {
  getCatalogImportStore,
  type CatalogImportRow,
} from "@/services/catalogImportStore";
import { deverpClient } from "@/integrations/deverp/client";
import { resolveChannelVariantPrice } from "@/services/channelUnitPrice";
import {
  loadDesignMarkupMap,
  normalizeDesignNoKey,
} from "@/services/connectionDesignMarkups";
import { resolveDesignImageUrls } from "@/services/designImageUrls";
import { resolveDesignShopifyTaxonomy } from "@/services/designShopifyTaxonomy";
import { detailsFromInventoryJob } from "@/services/jobVariantDetails";
import {
  designInFeed,
  requireSyncableEntitlements,
} from "@/services/entitlements";
import {
  getProductMappingStore,
  upsertProductMapping,
} from "@/services/productMappings";
import { getVariantMappingStore } from "@/services/variantMappings";
import { writeSyncLog } from "@/services/syncLog";
import { enqueueInventorySync } from "@/services/queue";
import type { MarkupMode } from "@/services/markup";

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
): Promise<
  Array<{
    designNo: string;
    title: string;
    totamt?: string;
    imageUrls: string[];
    productType?: string;
    tags: string[];
  }>
> {
  const out: Array<{
    designNo: string;
    title: string;
    totamt?: string;
    imageUrls: string[];
    productType?: string;
    tags: string[];
  }> = [];
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
      const taxonomy = resolveDesignShopifyTaxonomy({
        category: item.category,
        collection: item.collection,
        subcategory: item.subcategory,
        producttype: item.producttype,
      });
      out.push({
        designNo,
        title: String(item.titleline || designNo).trim() || designNo,
        totamt: item.totamt != null ? String(item.totamt) : undefined,
        imageUrls: resolveDesignImageUrls({
          designNo,
          imageUrls: item.image_urls,
          thumbnailUrl: item.thumbnail_url,
          imageBasePath: item.image_base_path,
          defaultColor: item.default_color,
        }),
        productType: taxonomy.productType,
        tags: taxonomy.tags,
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
  customerId: number;
  canViewPrices: boolean;
  canViewInventory: boolean;
  syncInventory: boolean;
  markupMode?: string | null;
  markupValue?: number | null;
  markupBps?: number | null;
  designMarkup?: { markupMode: MarkupMode | string; markupValue: number } | null;
  designNo: string;
  title: string;
  defaultPrice: number;
  imageUrls: string[];
  productType?: string;
  tags: string[];
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

  const variants = [];
  for (const j of jobs) {
    const jobNo = String(j.job_no).trim();
    const price = await resolveChannelVariantPrice({
      customerId: input.customerId,
      designNo: input.designNo,
      jobNo,
      fallbackPrice: parsePrice(j.totamt ?? input.defaultPrice),
      canViewPrices: input.canViewPrices,
      markupMode: input.markupMode,
      markupValue: input.markupValue,
      markupBps: input.markupBps,
      designMarkup: input.designMarkup ?? null,
    });
    variants.push({
      jobNo,
      sku: jobNo,
      price,
      quantity: 1,
      details: detailsFromInventoryJob(
        j as Record<string, unknown>,
        input.productType,
      ),
    });
  }

  const adapter = AdapterRouter.get(input.platform);
  const mappingStore = getProductMappingStore();
  const existing = await mappingStore.getByDesign(input.connectionId, input.designNo);
  const variantStore = getVariantMappingStore();

  const liveEntitlements = await requireSyncableEntitlements(input.customerId, {
    fresh: true,
  });
  if (
    !liveEntitlements ||
    !liveEntitlements.permissions.can_view_designs ||
    !designInFeed(liveEntitlements, input.designNo)
  ) {
    await writeSyncLog({
      connectionId: input.connectionId,
      platform: input.platform,
      jobType: "product",
      status: "SKIPPED",
      designNo: input.designNo,
      message: "entitlement_revoked_before_import_mutation",
    });
    return "skipped";
  }

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
        imageUrls: input.imageUrls,
        productType: input.productType,
        tags: input.tags,
        variants,
        existingVariants,
      });
    } else {
      result = await adapter.createProduct({
        connectionId: input.connectionId,
        designNo: input.designNo,
        title: input.title,
        credentialsSecretRef: input.credentialsSecretRef ?? undefined,
        imageUrls: input.imageUrls,
        productType: input.productType,
        tags: input.tags,
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

    if (input.canViewInventory && input.syncInventory) {
      for (const variant of result.variants) {
        const quantity =
          variants.find((candidate) => candidate.jobNo === variant.jobNo)?.quantity ?? 0;
        await enqueueInventorySync({
          kind: "inventory.sync",
          connectionId: input.connectionId,
          platform: input.platform,
          designNo: input.designNo,
          jobNo: variant.jobNo,
          quantity,
        });
      }
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
  registerDefaultAdapters();
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
  const entitlements = await requireSyncableEntitlements(connection.customer_id, {
    fresh: true,
  });
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

  const designMarkupMap = await loadDesignMarkupMap(connection.id);

  let failed = 0;
  let skipped = 0;
  let processed = 0;

  await mapPool(designs, concurrency, async (design) => {
    const designOverride =
      designMarkupMap.get(normalizeDesignNoKey(design.designNo)) ?? null;
    const outcome = await importOneDesign({
      connectionId: connection.id,
      platform: connection.platform,
      credentialsSecretRef: connection.credentials_secret_ref,
      customerId: connection.customer_id!,
      canViewPrices: Boolean(entitlements.permissions.can_view_prices),
      canViewInventory: Boolean(entitlements.permissions.can_view_inventory),
      syncInventory: connection.sync_inventory,
      markupMode: connection.markup_mode,
      markupValue: connection.markup_value,
      markupBps: connection.markup_bps,
      designMarkup: designOverride,
      designNo: design.designNo,
      title: design.title,
      defaultPrice: parsePrice(design.totamt),
      imageUrls: design.imageUrls,
      productType: design.productType,
      tags: design.tags,
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
