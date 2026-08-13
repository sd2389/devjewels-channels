/**
 * SQS worker handlers — shared across platforms.
 * Each message is connection-scoped; AdapterRouter picks the platform.
 */
import { registerDefaultAdapters } from "@/channels/registerAdapters";
import { runCatalogImport } from "@/services/catalogImportService";
import { runInventorySyncJob } from "@/services/inventorySyncService";
import { runOrderProcessingJob } from "@/services/orderProcessingService";
import { runProductSyncJob } from "@/services/productSyncService";

export type QueueJobEnvelope = {
  connectionId: string;
  platform: "SHOPIFY" | "WOOCOMMERCE" | "MAGENTO";
  attempt?: number;
};

export type InventorySyncJob = QueueJobEnvelope & {
  kind: "inventory.sync";
  designNo: string;
  jobNo: string;
  quantity: number;
};

export type OrderProcessingJob = QueueJobEnvelope & {
  kind: "order.process";
  webhookEventId: string;
};

export type ProductSyncJob = QueueJobEnvelope & {
  kind: "product.sync";
  designNo: string;
  /** sync (default) | delete — entitlement revoke / key_revoked */
  action?: "sync" | "delete";
  /** Optional catalog import job id for progress tracking (full import). */
  importId?: string;
};

export type PriceSyncJob = QueueJobEnvelope & {
  kind: "price.sync";
  designNo: string;
  jobNo: string;
  price: number;
  currency: string;
};

let adaptersReady = false;

function ensureAdapters(): void {
  if (!adaptersReady) {
    registerDefaultAdapters();
    adaptersReady = true;
  }
}

/** Test helper: allow re-register after store swaps. */
export function resetAdaptersReadyForTests(): void {
  adaptersReady = false;
}

export async function handleInventorySync(job: InventorySyncJob): Promise<void> {
  ensureAdapters();
  const outcome = await runInventorySyncJob(job);
  console.info("inventory_sync_outcome", {
    connectionId: job.connectionId,
    platform: job.platform,
    designNo: job.designNo,
    jobNo: job.jobNo,
    outcome,
  });
}

export async function handleOrderProcessing(job: OrderProcessingJob): Promise<void> {
  ensureAdapters();
  const outcome = await runOrderProcessingJob(job);
  console.info("order_processing_outcome", {
    connectionId: job.connectionId,
    platform: job.platform,
    webhookEventId: job.webhookEventId,
    outcome,
  });
}

export async function handleProductSync(job: ProductSyncJob): Promise<void> {
  ensureAdapters();

  // Full-catalog import when importId is set (connect / manual re-import).
  if (job.importId) {
    const result = await runCatalogImport({
      connectionId: job.connectionId,
      importId: job.importId,
      maxDesigns: 200,
      concurrency: 3,
    });
    console.info("product_sync_import_outcome", {
      connectionId: job.connectionId,
      platform: job.platform,
      importId: result.importId,
      status: result.status,
      processed: result.processed,
      failed: result.failed,
      skipped: result.skipped,
    });
    return;
  }

  // Per-design create/update from catalog.updated / price.updated / unmapped inventory.
  const outcome = await runProductSyncJob(job);
  console.info("product_sync_outcome", {
    connectionId: job.connectionId,
    platform: job.platform,
    designNo: job.designNo,
    outcome,
  });
}

export async function handlePriceSync(job: PriceSyncJob): Promise<void> {
  // price.updated is enqueued as product.sync; dedicated PriceSync queue is unused.
  console.warn("handlePriceSync_unused", {
    connectionId: job.connectionId,
    designNo: job.designNo,
    jobNo: job.jobNo,
    hint: "price.updated fans out to product.sync",
  });
  throw new Error(
    "handlePriceSync unused — price.updated enqueues product.sync instead",
  );
}
