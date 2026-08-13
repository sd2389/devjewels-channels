/**
 * Job enqueue: SQS when URL set, else in-memory/log for local Next-only.
 */
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type {
  InventorySyncJob,
  OrderProcessingJob,
  ProductSyncJob,
} from "@/workers/handlers";

const memoryInventoryQueue: InventorySyncJob[] = [];
const memoryOrderQueue: OrderProcessingJob[] = [];
const memoryProductQueue: ProductSyncJob[] = [];
let sqsClient: SQSClient | null = null;

function getSqs(): SQSClient {
  if (!sqsClient) {
    sqsClient = new SQSClient({});
  }
  return sqsClient;
}

export async function enqueueInventorySync(job: InventorySyncJob): Promise<{
  transport: "sqs" | "memory";
  messageId?: string;
}> {
  const queueUrl = (process.env.INVENTORY_SYNC_QUEUE_URL || "").trim();
  const body = JSON.stringify(job);

  if (queueUrl) {
    const result = await getSqs().send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
      }),
    );
    console.info("inventory_sync_enqueued transport=sqs", {
      connectionId: job.connectionId,
      platform: job.platform,
      designNo: job.designNo,
      jobNo: job.jobNo,
      messageId: result.MessageId,
    });
    return { transport: "sqs", messageId: result.MessageId };
  }

  memoryInventoryQueue.push(job);
  console.info("inventory_sync_enqueued transport=memory", {
    connectionId: job.connectionId,
    platform: job.platform,
    designNo: job.designNo,
    jobNo: job.jobNo,
    depth: memoryInventoryQueue.length,
  });
  return { transport: "memory" };
}

export async function enqueueOrderProcessing(job: OrderProcessingJob): Promise<{
  transport: "sqs" | "memory";
  messageId?: string;
}> {
  const queueUrl = (process.env.ORDER_PROCESSING_QUEUE_URL || "").trim();
  const body = JSON.stringify(job);

  if (queueUrl) {
    const result = await getSqs().send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
      }),
    );
    console.info("order_processing_enqueued transport=sqs", {
      connectionId: job.connectionId,
      platform: job.platform,
      webhookEventId: job.webhookEventId,
      messageId: result.MessageId,
    });
    return { transport: "sqs", messageId: result.MessageId };
  }

  memoryOrderQueue.push(job);
  console.info("order_processing_enqueued transport=memory", {
    connectionId: job.connectionId,
    platform: job.platform,
    webhookEventId: job.webhookEventId,
    depth: memoryOrderQueue.length,
  });
  return { transport: "memory" };
}

export async function enqueueProductSync(job: ProductSyncJob): Promise<{
  transport: "sqs" | "memory";
  messageId?: string;
}> {
  const queueUrl = (process.env.PRODUCT_SYNC_QUEUE_URL || "").trim();
  const body = JSON.stringify(job);

  if (queueUrl) {
    const result = await getSqs().send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
      }),
    );
    console.info("product_sync_enqueued transport=sqs", {
      connectionId: job.connectionId,
      platform: job.platform,
      designNo: job.designNo,
      importId: job.importId,
      messageId: result.MessageId,
    });
    return { transport: "sqs", messageId: result.MessageId };
  }

  memoryProductQueue.push(job);
  console.info("product_sync_enqueued transport=memory", {
    connectionId: job.connectionId,
    platform: job.platform,
    designNo: job.designNo,
    importId: job.importId,
    depth: memoryProductQueue.length,
  });
  return { transport: "memory" };
}

/** Drain local fallback queue (tests / local smoke). */
export function drainMemoryInventoryQueue(): InventorySyncJob[] {
  return memoryInventoryQueue.splice(0, memoryInventoryQueue.length);
}

export function peekMemoryInventoryQueueDepth(): number {
  return memoryInventoryQueue.length;
}

export function drainMemoryOrderQueue(): OrderProcessingJob[] {
  return memoryOrderQueue.splice(0, memoryOrderQueue.length);
}

export function peekMemoryOrderQueueDepth(): number {
  return memoryOrderQueue.length;
}

export function drainMemoryProductQueue(): ProductSyncJob[] {
  return memoryProductQueue.splice(0, memoryProductQueue.length);
}

export function peekMemoryProductQueueDepth(): number {
  return memoryProductQueue.length;
}
