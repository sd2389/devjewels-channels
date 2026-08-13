/**
 * Catalog / price fan-out: only connections whose customer is entitled
 * for the design_no (Django entitlements check). Platform-agnostic.
 */
import type {
  CatalogUpdatedEnvelope,
  PriceUpdatedEnvelope,
} from "@/services/events";
import { listActiveConnectionsWithCustomer } from "@/services/connections";
import { filterEntitledCustomerIds } from "@/services/entitlements";
import { enqueueProductSync } from "@/services/queue";
import type { ProductSyncJob } from "@/workers/handlers";

const FANOUT_MAX = 50;

function skeletonEnabled(): boolean {
  const raw = (process.env.CHANNELS_ENQUEUE_SKELETON_ON_UNMAPPED ?? "0")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

async function enqueueForDesign(
  designNo: string,
  source: string,
  eventId: string,
  requirePermission: "can_view_designs" | "can_view_prices" = "can_view_designs",
): Promise<{ enqueued: number; skeleton: boolean; transport?: string }> {
  const connections = await listActiveConnectionsWithCustomer(FANOUT_MAX);
  const withProducts = connections.filter((c) => c.sync_products);
  const customerIds = withProducts
    .map((c) => c.customer_id)
    .filter((id): id is number => id != null);

  const entitled = await filterEntitledCustomerIds({
    designNo,
    customerIds,
    requirePermission,
  });
  const entitledSet = new Set(entitled.map((e) => e.customer_id));

  const jobs: ProductSyncJob[] = withProducts
    .filter((c) => c.customer_id != null && entitledSet.has(c.customer_id))
    .map((c) => ({
      kind: "product.sync",
      connectionId: c.id,
      platform: c.platform,
      designNo,
      action: "sync",
    }));

  let skeleton = false;
  if (jobs.length === 0 && skeletonEnabled()) {
    jobs.push({
      kind: "product.sync",
      connectionId: "_skeleton",
      platform: "SHOPIFY",
      designNo,
      action: "sync",
    });
    skeleton = true;
  }

  let transport: string | undefined;
  for (const job of jobs) {
    const result = await enqueueProductSync(job);
    transport = result.transport;
  }

  console.info("catalog_fan_out", {
    event_id: eventId,
    source,
    design_no: designNo,
    enqueued: jobs.length,
    skeleton,
    transport,
  });

  return { enqueued: jobs.length, skeleton, transport };
}

export async function fanOutCatalogUpdated(
  event: CatalogUpdatedEnvelope,
): Promise<{ enqueued: number; skeleton: boolean; transport?: string }> {
  return enqueueForDesign(
    event.data.design_no,
    `catalog.${event.data.change_type}`,
    event.event_id,
    "can_view_designs",
  );
}

/**
 * price.updated → same product.sync path (pull fresh price from Django facade).
 */
export async function fanOutPriceUpdated(
  event: PriceUpdatedEnvelope,
): Promise<{ enqueued: number; skeleton: boolean; transport?: string }> {
  return enqueueForDesign(
    event.data.design_no,
    "price.updated",
    event.event_id,
    "can_view_prices",
  );
}

/** Used by inventory fan-out when a job has no variant_mapping yet. */
export async function fanOutProductSyncForDesign(
  designNo: string,
  eventId: string,
): Promise<{ enqueued: number; skeleton: boolean; transport?: string }> {
  return enqueueForDesign(designNo, "inventory.unmapped", eventId);
}
