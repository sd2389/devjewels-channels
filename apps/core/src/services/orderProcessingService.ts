/**
 * Order processing: load webhook_event → adapter.handleOrder → Django reserve.
 */
import { AdapterRouter } from "@/channels/router";
import {
  DeverpHttpError,
  deverpClient,
} from "@/integrations/deverp/client";
import { safeErrorMessage } from "@/security/redact";
import { writeSyncLog } from "@/services/syncLog";
import { getWebhookEventStore } from "@/services/webhookEvents";
import type { OrderProcessingJob } from "@/workers/handlers";

export type OrderProcessOutcome = "SUCCESS" | "FAILED" | "SKIPPED";

export async function runOrderProcessingJob(
  job: OrderProcessingJob,
): Promise<OrderProcessOutcome> {
  const store = getWebhookEventStore();
  const event = await store.getById(job.webhookEventId);
  if (!event) {
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "order",
      status: "FAILED",
      message: "webhook_event_not_found",
    });
    return "FAILED";
  }

  if (event.status === "processed") {
    return "SKIPPED";
  }

  let payload: unknown;
  try {
    payload = event.payload_ref ? JSON.parse(event.payload_ref) : null;
  } catch {
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "order",
      status: "FAILED",
      message: "invalid_payload_json",
    });
    await store.markStatus(event.id, "failed");
    return "FAILED";
  }

  const adapter = AdapterRouter.get(job.platform);
  try {
    const connection = await (
      await import("@/services/connections")
    ).getConnectionById(job.connectionId);
    if (!connection?.customer_id) {
      await writeSyncLog({
        connectionId: job.connectionId,
        platform: job.platform,
        jobType: "order",
        status: "SKIPPED",
        message: "connection_missing_customer_id",
      });
      await store.markStatus(event.id, "failed");
      return "SKIPPED";
    }

    const { fetchCustomerEntitlements } = await import("@/services/entitlements");
    const entitlements = await fetchCustomerEntitlements(connection.customer_id);
    if (!entitlements.key_present || !entitlements.permissions.can_place_orders) {
      const gateMessage = !entitlements.key_present
        ? "no_active_api_key"
        : "can_place_orders_false";
      await writeSyncLog({
        connectionId: job.connectionId,
        platform: job.platform,
        jobType: "order",
        status: "SKIPPED",
        message: gateMessage,
      });
      await store.markStatus(event.id, "failed");
      return "SKIPPED";
    }

    const normalized = await adapter.handleOrder(payload, job.connectionId);
    const result = await deverpClient.reserveOrder({
      platform: normalized.platform,
      connection_id: normalized.connectionId,
      customer_id: connection.customer_id,
      external_order_id: normalized.externalOrderId,
      currency: normalized.currency,
      customer_email: normalized.customerEmail,
      lines: normalized.lines.map((line) => ({
        design_no: line.designNo,
        job_no: line.jobNo,
        quantity: line.quantity,
        external_line_id: line.externalLineId,
      })),
    });

    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "order",
      status: "SUCCESS",
      message: result.duplicate
        ? `duplicate order_number=${result.order_number}`
        : `order_number=${result.order_number}`,
      payloadRef: event.external_event_id,
    });
    await store.markStatus(event.id, "processed");
    return "SUCCESS";
  } catch (err) {
    const message = safeErrorMessage(err);
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "order",
      status: "FAILED",
      message,
      payloadRef: event.external_event_id,
    });
    await store.markStatus(event.id, "failed");
    // Non-retryable conflict (qty 0) should not poison the queue forever.
    if (err instanceof DeverpHttpError && (err.status === 409 || err.status === 400)) {
      return "FAILED";
    }
    throw err;
  }
}
