/**
 * Lambda/SQS entrypoint exports.
 * SST wires inventorySync.subscribe → inventorySync.handler.
 * Local: call handlers / drainMemoryInventoryQueue from smoke tests.
 */
import {
  handleInventorySync,
  handleOrderProcessing,
  handlePriceSync,
  handleProductSync,
  type InventorySyncJob,
  type OrderProcessingJob,
  type PriceSyncJob,
  type ProductSyncJob,
} from "./handlers";

export { handler as inventorySyncHandler } from "./inventorySync";
export { handler as orderProcessingHandler } from "./orderProcessing";
export { handler as productSyncHandler } from "./productSync";

export async function inventorySyncWorker(job: InventorySyncJob): Promise<void> {
  await handleInventorySync(job);
}

export async function orderProcessingWorker(job: OrderProcessingJob): Promise<void> {
  await handleOrderProcessing(job);
}

export async function productSyncWorker(job: ProductSyncJob): Promise<void> {
  await handleProductSync(job);
}

export async function priceSyncWorker(job: PriceSyncJob): Promise<void> {
  await handlePriceSync(job);
}
