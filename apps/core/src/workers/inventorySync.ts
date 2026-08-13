/**
 * SQS Lambda entry for inventory-sync queue.
 * Wired from sst.config.ts via inventorySync.subscribe.
 */
import { handleInventorySync, type InventorySyncJob } from "./handlers";

type SqsRecord = { body: string };
type SqsEvent = { Records: SqsRecord[] };

export async function handler(event: SqsEvent): Promise<void> {
  for (const record of event.Records) {
    let job: InventorySyncJob;
    try {
      job = JSON.parse(record.body) as InventorySyncJob;
    } catch {
      console.error("inventory_sync_bad_json");
      throw new Error("Invalid inventory-sync job JSON");
    }
    if (job.kind !== "inventory.sync") {
      throw new Error(`Unexpected job kind: ${String((job as { kind?: string }).kind)}`);
    }
    await handleInventorySync(job);
  }
}
