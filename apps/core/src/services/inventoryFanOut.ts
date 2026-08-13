/**
 * Inventory fan-out: only entitled connections with can_view_inventory.
 * When unmapped, enqueue product.sync for entitled connections only.
 */
import { CHANNELS_SCHEMA, tryGetChannelsDb } from "@/db/shared/client";
import type { InventoryUpdatedEnvelope } from "@/services/events";
import { fanOutProductSyncForDesign } from "@/services/catalogFanOut";
import { listActiveConnectionsWithCustomer } from "@/services/connections";
import { filterEntitledCustomerIds } from "@/services/entitlements";
import { enqueueInventorySync } from "@/services/queue";
import type { ChannelPlatform } from "@/channels/types";
import type { InventorySyncJob } from "@/workers/handlers";

export type InventoryUpdatedEvent = InventoryUpdatedEnvelope;

export type VariantMappingRow = {
  connection_id: string;
  platform: ChannelPlatform;
  design_no: string;
  job_no: string;
  customer_id: number | null;
};

async function loadVariantMappings(
  designNo: string,
  jobNo: string,
): Promise<VariantMappingRow[]> {
  const db = tryGetChannelsDb();
  if (!db) {
    return [];
  }
  const result = await db.query<{
    connection_id: string;
    platform: string;
    design_no: string;
    job_no: string;
    customer_id: number | null;
  }>(
    `SELECT vm.connection_id::text AS connection_id,
            c.platform,
            c.customer_id,
            vm.design_no,
            vm.job_no
     FROM ${CHANNELS_SCHEMA}.variant_mapping vm
     INNER JOIN ${CHANNELS_SCHEMA}.connection c ON c.id = vm.connection_id
     WHERE c.is_active = TRUE
       AND c.sync_inventory = TRUE
       AND c.customer_id IS NOT NULL
       AND upper(replace(vm.design_no, ' ', '')) = upper(replace($1, ' ', ''))
       AND upper(vm.job_no) = upper($2)`,
    [designNo, jobNo],
  );
  return result.rows
    .filter(
      (row) =>
        row.platform === "SHOPIFY" ||
        row.platform === "WOOCOMMERCE" ||
        row.platform === "MAGENTO",
    )
    .map((row) => ({
      connection_id: row.connection_id,
      platform: row.platform as ChannelPlatform,
      design_no: row.design_no,
      job_no: row.job_no,
      customer_id: row.customer_id == null ? null : Number(row.customer_id),
    }));
}

function skeletonEnabled(): boolean {
  const raw = (process.env.CHANNELS_ENQUEUE_SKELETON_ON_UNMAPPED ?? "0")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Pure fan-out filter: only connections whose customer is entitled
 * (design in feed + can_view_inventory). Skips null customer_id.
 */
export function buildInventoryJobsForEntitledMappings(
  mappings: VariantMappingRow[],
  entitledCustomerIds: ReadonlySet<number>,
  designNo: string,
  jobNo: string,
  quantity: number,
): InventorySyncJob[] {
  return mappings
    .filter(
      (m) => m.customer_id != null && entitledCustomerIds.has(m.customer_id),
    )
    .map((m) => ({
      kind: "inventory.sync" as const,
      connectionId: m.connection_id,
      platform: m.platform,
      designNo,
      jobNo,
      quantity,
    }));
}

export async function fanOutInventoryUpdated(
  event: InventoryUpdatedEvent,
): Promise<{
  enqueued: number;
  skeleton: boolean;
  transport?: string;
  productSyncEnqueued?: number;
}> {
  const designNo = event.data.design_no;
  const jobNo = event.data.job_no;
  const quantity = event.data.new_quantity;

  const mappings = await loadVariantMappings(designNo, jobNo);
  const customerIds = [
    ...new Set(
      mappings
        .map((m) => m.customer_id)
        .filter((id): id is number => id != null),
    ),
  ];

  // Also consider active entitled connections without mapping yet (for product.sync).
  const active = await listActiveConnectionsWithCustomer(50);
  for (const c of active) {
    if (c.customer_id != null && c.sync_inventory) {
      customerIds.push(c.customer_id);
    }
  }
  const uniqueCustomerIds = [...new Set(customerIds)];

  const entitled = await filterEntitledCustomerIds({
    designNo,
    customerIds: uniqueCustomerIds,
    requirePermission: "can_view_inventory",
  });
  const entitledSet = new Set(entitled.map((e) => e.customer_id));

  const jobs: InventorySyncJob[] = buildInventoryJobsForEntitledMappings(
    mappings,
    entitledSet,
    designNo,
    jobNo,
    quantity,
  );

  let skeleton = false;
  let productSyncEnqueued = 0;

  if (jobs.length === 0) {
    // Unmapped: product.sync only for entitled connections (catalogFanOut filters).
    const productFanOut = await fanOutProductSyncForDesign(designNo, event.event_id);
    productSyncEnqueued = productFanOut.enqueued;
    skeleton = productFanOut.skeleton;

    if (productSyncEnqueued === 0 && skeletonEnabled()) {
      jobs.push({
        kind: "inventory.sync",
        connectionId: "_skeleton",
        platform: "SHOPIFY",
        designNo,
        jobNo,
        quantity,
      });
      skeleton = true;
    }
  }

  let transport: string | undefined;
  for (const job of jobs) {
    const result = await enqueueInventorySync(job);
    transport = result.transport;
  }

  console.info("inventory_fan_out", {
    event_id: event.event_id,
    design_no: designNo,
    job_no: jobNo,
    enqueued: jobs.length,
    productSyncEnqueued,
    skeleton,
    transport,
  });

  return {
    enqueued: jobs.length,
    skeleton,
    transport,
    productSyncEnqueued,
  };
}
