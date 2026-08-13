/**
 * SQS Lambda entry for product-sync queue.
 * Wired from sst.config.ts via productSync.subscribe.
 */
import { handleProductSync, type ProductSyncJob } from "./handlers";

type SqsRecord = { body: string };
type SqsEvent = { Records: SqsRecord[] };

export async function handler(event: SqsEvent): Promise<void> {
  for (const record of event.Records) {
    let job: ProductSyncJob;
    try {
      job = JSON.parse(record.body) as ProductSyncJob;
    } catch {
      console.error("product_sync_bad_json");
      throw new Error("Invalid product-sync job JSON");
    }
    if (job.kind !== "product.sync") {
      throw new Error(`Unexpected job kind: ${String((job as { kind?: string }).kind)}`);
    }
    await handleProductSync(job);
  }
}
