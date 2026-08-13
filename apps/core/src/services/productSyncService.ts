/**
 * Per-design product sync: create/update when entitled; delete when revoked.
 * Pulls title/price/jobs from Django channels_api facades (customer-scoped).
 */
import { AdapterRouter } from "@/channels/router";
import {
  InventorySkipError,
  NotImplementedError,
} from "@/channels/types";
import { getConnectionById } from "@/services/connections";
import { deverpClient } from "@/integrations/deverp/client";
import {
  designInFeed,
  requireSyncableEntitlements,
} from "@/services/entitlements";
import { applyConnectionMarkup } from "@/services/markup";
import {
  getProductMappingStore,
  upsertProductMapping,
} from "@/services/productMappings";
import { getVariantMappingStore } from "@/services/variantMappings";
import { writeSyncLog } from "@/services/syncLog";
import { enqueueInventorySync } from "@/services/queue";
import type { ProductSyncJob } from "@/workers/handlers";

export type ProductSyncOutcome =
  | "SUCCESS"
  | "SKIPPED"
  | "RETRYING"
  | "FAILED"
  | "CREATED"
  | "UPDATED"
  | "DELETED";

function parsePrice(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? "0"));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function safeErrorMessage(err: unknown): string {
  if (err instanceof InventorySkipError) return err.reason;
  if (err instanceof Error) {
    return err.message.replace(/shpat_[a-zA-Z0-9]+/g, "shpat_***").slice(0, 500);
  }
  return "unknown_error";
}

function isRateLimitError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: string }).name === "ShopifyRateLimitError"
  );
}

async function runProductDelete(
  job: ProductSyncJob,
): Promise<ProductSyncOutcome> {
  const connection = await getConnectionById(job.connectionId);
  if (!connection) {
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "product",
      status: "FAILED",
      designNo: job.designNo,
      message: "connection_not_found",
    });
    return "FAILED";
  }

  const designNo = String(job.designNo || "").trim();
  const mappingStore = getProductMappingStore();
  const existing = await mappingStore.getByDesign(job.connectionId, designNo);
  if (!existing?.external_product_id) {
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "product",
      status: "SKIPPED",
      designNo,
      message: "not_mapped",
    });
    return "SKIPPED";
  }

  const adapter = AdapterRouter.get(job.platform);
  try {
    await adapter.deleteProduct({
      connectionId: job.connectionId,
      designNo,
      externalProductId: existing.external_product_id,
      credentialsSecretRef: connection.credentials_secret_ref ?? undefined,
    });
    await mappingStore.deleteByDesign(job.connectionId, designNo);
    // Best-effort: drop variant mappings for this design (SQL if available).
    try {
      const variantStore = getVariantMappingStore() as {
        deleteByDesign?: (c: string, d: string) => Promise<unknown>;
      };
      if (typeof variantStore.deleteByDesign === "function") {
        await variantStore.deleteByDesign(job.connectionId, designNo);
      }
    } catch {
      // ignore — product mapping already removed
    }
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "product",
      status: "SUCCESS",
      designNo,
      message: "deleted",
    });
    return "DELETED";
  } catch (err) {
    if (err instanceof NotImplementedError) {
      await writeSyncLog({
        connectionId: job.connectionId,
        platform: job.platform,
        jobType: "product",
        status: "SKIPPED",
        designNo,
        message: "not_implemented",
      });
      return "SKIPPED";
    }
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "product",
      status: "FAILED",
      designNo,
      message: safeErrorMessage(err),
    });
    throw err;
  }
}

/**
 * Sync one design_no for one connection (create, update, or delete).
 */
export async function runProductSyncJob(
  job: ProductSyncJob,
): Promise<ProductSyncOutcome> {
  if (job.connectionId === "_skeleton") {
    console.info("product_sync_skeleton_skip", { designNo: job.designNo });
    await writeSyncLog({
      connectionId: null,
      platform: job.platform,
      jobType: "product",
      status: "SKIPPED",
      designNo: job.designNo,
      message: "skeleton",
    });
    return "SKIPPED";
  }

  if (job.action === "delete") {
    return runProductDelete(job);
  }

  const connection = await getConnectionById(job.connectionId);
  if (!connection) {
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "product",
      status: "FAILED",
      designNo: job.designNo,
      message: "connection_not_found",
    });
    return "FAILED";
  }

  if (!connection.is_active || !connection.sync_products) {
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "product",
      status: "SKIPPED",
      designNo: job.designNo,
      message: "connection_disabled",
    });
    return "SKIPPED";
  }

  const entitlements = await requireSyncableEntitlements(connection.customer_id);
  if (!entitlements) {
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "product",
      status: "SKIPPED",
      designNo: job.designNo,
      message: "no_api_key_or_permission",
    });
    return "SKIPPED";
  }

  const designNo = String(job.designNo || "").trim();
  if (!designNo) {
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "product",
      status: "SKIPPED",
      designNo: "",
      message: "empty_design_no",
    });
    return "SKIPPED";
  }

  if (!designInFeed(entitlements, designNo)) {
    // Not entitled → delete if mapped, else skip.
    const mapped = await getProductMappingStore().getByDesign(
      job.connectionId,
      designNo,
    );
    if (mapped) {
      return runProductDelete({ ...job, action: "delete" });
    }
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "product",
      status: "SKIPPED",
      designNo,
      message: "not_entitled",
    });
    return "SKIPPED";
  }

  let title = designNo;
  let defaultPrice = 0;
  try {
    const product = await deverpClient.getProduct(designNo, connection.customer_id!);
    title = String(product.titleline || designNo).trim() || designNo;
    defaultPrice = parsePrice(product.totamt);
  } catch (err) {
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "product",
      status: "FAILED",
      designNo,
      message: safeErrorMessage(err),
    });
    throw err;
  }

  const canViewInventory = entitlements.permissions.can_view_inventory;
  const canViewPrices = entitlements.permissions.can_view_prices;

  const inventory = canViewInventory
    ? await deverpClient.getInventory(designNo)
    : { jobs: [] as Array<{ job_no?: string; totamt?: string | number }> };
  const jobs = (inventory.jobs || []).filter((j) => String(j.job_no || "").trim());
  if (jobs.length === 0) {
    // Still create a single placeholder variant so the product exists; qty 0.
    jobs.push({ job_no: designNo, totamt: defaultPrice });
  }

  const variants = [];
  for (const j of jobs) {
    const jobNo = String(j.job_no).trim();
    let unitPrice = parsePrice(j.totamt ?? defaultPrice);
    if (canViewPrices && connection.customer_id != null) {
      try {
        const priced = await deverpClient.getPrice({
          customerId: connection.customer_id,
          designNo,
          jobNo: jobNo === designNo ? undefined : jobNo,
        });
        unitPrice = parsePrice(priced.final_price);
      } catch {
        // fall back to inventory/design totamt
      }
    } else if (!canViewPrices) {
      unitPrice = 0;
    }
    unitPrice = applyConnectionMarkup(unitPrice, {
      markupMode: connection.markup_mode,
      markupValue: connection.markup_value,
      markupBps: connection.markup_bps,
    });
    variants.push({
      jobNo,
      sku: jobNo,
      price: unitPrice,
      quantity: canViewInventory && jobNo !== designNo ? 1 : 0,
    });
  }

  const mappingStore = getProductMappingStore();
  const existing = await mappingStore.getByDesign(job.connectionId, designNo);
  const variantStore = getVariantMappingStore();
  const adapter = AdapterRouter.get(job.platform);

  try {
    let outcome: ProductSyncOutcome;
    let resultVariants: Array<{
      jobNo: string;
      externalVariantId: string;
      externalInventoryItemId?: string;
    }>;

    if (existing?.external_product_id) {
      const existingVariants = [];
      for (const v of variants) {
        const mapped = await variantStore.getByDesignJob(
          job.connectionId,
          designNo,
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

      const updated = await adapter.updateProduct({
        connectionId: job.connectionId,
        designNo,
        title,
        credentialsSecretRef: connection.credentials_secret_ref ?? undefined,
        externalProductId: existing.external_product_id,
        variants,
        existingVariants,
      });

      await upsertProductMapping({
        connectionId: job.connectionId,
        designNo,
        externalProductId: updated.externalProductId,
      });
      for (const variant of updated.variants) {
        await variantStore.upsert({
          connectionId: job.connectionId,
          designNo,
          jobNo: variant.jobNo,
          externalVariantId: variant.externalVariantId,
          externalInventoryItemId: variant.externalInventoryItemId ?? null,
        });
      }
      resultVariants = updated.variants;
      outcome = "UPDATED";
      await writeSyncLog({
        connectionId: job.connectionId,
        platform: job.platform,
        jobType: "product",
        status: "SUCCESS",
        designNo,
        message: `updated variants=${updated.variants.length}`,
      });
    } else {
      const created = await adapter.createProduct({
        connectionId: job.connectionId,
        designNo,
        title,
        credentialsSecretRef: connection.credentials_secret_ref ?? undefined,
        variants,
      });

      await upsertProductMapping({
        connectionId: job.connectionId,
        designNo,
        externalProductId: created.externalProductId,
      });
      for (const variant of created.variants) {
        await variantStore.upsert({
          connectionId: job.connectionId,
          designNo,
          jobNo: variant.jobNo,
          externalVariantId: variant.externalVariantId,
          externalInventoryItemId: variant.externalInventoryItemId ?? null,
        });
      }
      resultVariants = created.variants;
      outcome = "CREATED";
      await writeSyncLog({
        connectionId: job.connectionId,
        platform: job.platform,
        jobType: "product",
        status: "SUCCESS",
        designNo,
        message: `created variants=${created.variants.length}`,
      });
    }

    // Immediately set inventory after create/update when permission allows.
    if (canViewInventory && connection.sync_inventory) {
      for (const variant of resultVariants) {
        const qty =
          variants.find((v) => v.jobNo === variant.jobNo)?.quantity ?? 0;
        await enqueueInventorySync({
          kind: "inventory.sync",
          connectionId: job.connectionId,
          platform: job.platform,
          designNo,
          jobNo: variant.jobNo,
          quantity: qty,
        });
      }
    }

    return outcome;
  } catch (err) {
    if (err instanceof InventorySkipError) {
      await writeSyncLog({
        connectionId: job.connectionId,
        platform: job.platform,
        jobType: "product",
        status: "SKIPPED",
        designNo,
        message: err.reason,
      });
      return "SKIPPED";
    }
    if (err instanceof NotImplementedError) {
      await writeSyncLog({
        connectionId: job.connectionId,
        platform: job.platform,
        jobType: "product",
        status: "SKIPPED",
        designNo,
        message: "not_implemented",
      });
      return "SKIPPED";
    }
    if (isRateLimitError(err)) {
      await writeSyncLog({
        connectionId: job.connectionId,
        platform: job.platform,
        jobType: "product",
        status: "RETRYING",
        designNo,
        message: "rate_limited",
      });
      throw err;
    }
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "product",
      status: "FAILED",
      designNo,
      message: safeErrorMessage(err),
    });
    throw err;
  }
}
