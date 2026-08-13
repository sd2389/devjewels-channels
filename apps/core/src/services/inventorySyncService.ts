/**
 * Inventory sync orchestration: connection/mapping gates + sync_log + adapter call.
 * One connection failure must not be handled here as multi-connection fan-out
 * (fan-out already enqueues independent jobs).
 */
import { AdapterRouter } from "@/channels/router";
import {
  InventorySkipError,
  NotImplementedError,
} from "@/channels/types";
import { getConnectionById } from "@/services/connections";
import { writeSyncLog } from "@/services/syncLog";
import { getVariantMapping } from "@/services/variantMappings";
import type { InventorySyncJob } from "@/workers/handlers";

export type InventorySyncOutcome =
  | "SUCCESS"
  | "SKIPPED"
  | "RETRYING"
  | "FAILED";

import { safeErrorMessage as redactErrorMessage } from "@/security/redact";

function isRateLimitError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: string }).name === "ShopifyRateLimitError"
  );
}

function safeErrorMessage(err: unknown): string {
  if (err instanceof InventorySkipError) return err.reason;
  return redactErrorMessage(err);
}

export async function runInventorySyncJob(
  job: InventorySyncJob,
): Promise<InventorySyncOutcome> {
  if (job.connectionId === "_skeleton") {
    console.info("inventory_sync_skeleton_skip", {
      designNo: job.designNo,
      jobNo: job.jobNo,
    });
    await writeSyncLog({
      connectionId: null,
      platform: job.platform,
      jobType: "inventory",
      status: "SKIPPED",
      designNo: job.designNo,
      jobNo: job.jobNo,
      message: "skeleton",
    });
    return "SKIPPED";
  }

  const connection = await getConnectionById(job.connectionId);
  if (!connection) {
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "inventory",
      status: "FAILED",
      designNo: job.designNo,
      jobNo: job.jobNo,
      message: "connection_not_found",
    });
    return "FAILED";
  }

  if (!connection.is_active || !connection.sync_inventory) {
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "inventory",
      status: "SKIPPED",
      designNo: job.designNo,
      jobNo: job.jobNo,
      message: "connection_disabled",
    });
    return "SKIPPED";
  }

  const { requireSyncableEntitlements, designInFeed } = await import(
    "@/services/entitlements"
  );
  const entitlements = await requireSyncableEntitlements(connection.customer_id);
  if (
    !entitlements ||
    !entitlements.permissions.can_view_inventory ||
    !designInFeed(entitlements, job.designNo)
  ) {
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "inventory",
      status: "SKIPPED",
      designNo: job.designNo,
      jobNo: job.jobNo,
      message: "not_entitled_inventory",
    });
    return "SKIPPED";
  }

  const mapping = await getVariantMapping(
    job.connectionId,
    job.designNo,
    job.jobNo,
  );
  if (!mapping?.external_inventory_item_id) {
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "inventory",
      status: "SKIPPED",
      designNo: job.designNo,
      jobNo: job.jobNo,
      message: "missing_mapping",
    });
    console.info("inventory_sync_missing_mapping", {
      connectionId: job.connectionId,
      designNo: job.designNo,
      jobNo: job.jobNo,
    });
    return "SKIPPED";
  }

  const adapter = AdapterRouter.get(job.platform);
  try {
    await adapter.updateInventory({
      connectionId: job.connectionId,
      designNo: job.designNo,
      jobNo: job.jobNo,
      quantity: job.quantity,
      externalInventoryItemId: mapping.external_inventory_item_id,
      credentialsSecretRef: connection.credentials_secret_ref ?? undefined,
    });
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "inventory",
      status: "SUCCESS",
      designNo: job.designNo,
      jobNo: job.jobNo,
      message: "ok",
    });
    return "SUCCESS";
  } catch (err) {
    if (err instanceof InventorySkipError) {
      await writeSyncLog({
        connectionId: job.connectionId,
        platform: job.platform,
        jobType: "inventory",
        status: "SKIPPED",
        designNo: job.designNo,
        jobNo: job.jobNo,
        message: err.reason,
      });
      return "SKIPPED";
    }
    if (err instanceof NotImplementedError) {
      await writeSyncLog({
        connectionId: job.connectionId,
        platform: job.platform,
        jobType: "inventory",
        status: "SKIPPED",
        designNo: job.designNo,
        jobNo: job.jobNo,
        message: "not_implemented",
      });
      return "SKIPPED";
    }
    if (isRateLimitError(err)) {
      await writeSyncLog({
        connectionId: job.connectionId,
        platform: job.platform,
        jobType: "inventory",
        status: "RETRYING",
        designNo: job.designNo,
        jobNo: job.jobNo,
        message: "rate_limited",
      });
      throw err;
    }
    await writeSyncLog({
      connectionId: job.connectionId,
      platform: job.platform,
      jobType: "inventory",
      status: "FAILED",
      designNo: job.designNo,
      jobNo: job.jobNo,
      message: safeErrorMessage(err),
    });
    throw err;
  }
}
