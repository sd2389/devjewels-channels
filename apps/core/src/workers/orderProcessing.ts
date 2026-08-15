/**
 * SQS Lambda entry for order-processing queue.
 * Wired from sst.config.ts via orderProcessing.subscribe.
 */
import { handleOrderProcessing, type OrderProcessingJob } from "./handlers";

type SqsRecord = { body: string };
type SqsEvent = { Records: SqsRecord[] };

export async function handler(event: SqsEvent): Promise<void> {
  for (const record of event.Records) {
    let job: OrderProcessingJob;
    try {
      job = JSON.parse(record.body) as OrderProcessingJob;
    } catch {
      console.error("order_processing_bad_json");
      throw new Error("Invalid order-processing job JSON");
    }
    if (job.kind !== "order.process") {
      throw new Error(`Unexpected job kind: ${String((job as { kind?: string }).kind)}`);
    }
    await handleOrderProcessing(job);
  }
}
