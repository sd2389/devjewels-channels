/**
 * Entitlement-changed fan-out: customer-scoped grant / revoke / key_revoked /
 * permissions_changed. Customer API is SoT — no local design allowlist.
 */
import {
  listConnectionsByCustomerId,
  updateConnectionSyncFlags,
  type ConnectionRow,
} from "@/services/connections";
import {
  clearEntitlementCache,
  designInFeed,
  fetchCustomerEntitlements,
  type ChannelPermissions,
  type CustomerEntitlements,
} from "@/services/entitlements";
import { getProductMappingStore } from "@/services/productMappings";
import { enqueueProductSync } from "@/services/queue";
import type { ProductSyncJob } from "@/workers/handlers";
import type { EntitlementChangedEnvelope } from "@/services/events";

async function enqueueJobs(jobs: ProductSyncJob[]): Promise<number> {
  for (const job of jobs) {
    await enqueueProductSync(job);
  }
  return jobs.length;
}

async function deleteAllMappedDesigns(
  connection: ConnectionRow,
): Promise<number> {
  const mappings = await getProductMappingStore().listByConnection(connection.id);
  const jobs: ProductSyncJob[] = mappings.map((m) => ({
    kind: "product.sync",
    connectionId: connection.id,
    platform: connection.platform,
    designNo: m.design_no,
    action: "delete",
  }));
  return enqueueJobs(jobs);
}

/**
 * Re-derive connection sync flags from Customer API permissions (not a second allowlist).
 */
async function refreshSyncFlagsFromPermissions(
  connection: ConnectionRow,
  permissions: ChannelPermissions,
): Promise<ConnectionRow> {
  const updated = await updateConnectionSyncFlags(connection.id, {
    syncOrders: permissions.can_place_orders,
    syncInventory: permissions.can_view_inventory,
    syncPrice: permissions.can_view_prices,
    syncProducts: permissions.can_view_designs,
  });
  return updated ?? connection;
}

async function reconcileFeed(
  connection: ConnectionRow,
  ent: CustomerEntitlements,
): Promise<number> {
  const feed = new Set(
    ent.design_nos.map((n) => n.trim().toUpperCase().replace(/\s+/g, "")),
  );
  const mappings = await getProductMappingStore().listByConnection(connection.id);
  const deleteJobs: ProductSyncJob[] = [];
  for (const m of mappings) {
    const norm = m.design_no.trim().toUpperCase().replace(/\s+/g, "");
    if (!feed.has(norm)) {
      deleteJobs.push({
        kind: "product.sync",
        connectionId: connection.id,
        platform: connection.platform,
        designNo: m.design_no,
        action: "delete",
      });
    }
  }
  const syncJobs: ProductSyncJob[] =
    connection.is_active && connection.sync_products
      ? ent.design_nos.map((designNo) => ({
          kind: "product.sync" as const,
          connectionId: connection.id,
          platform: connection.platform,
          designNo,
          action: "sync" as const,
        }))
      : [];

  return enqueueJobs([...deleteJobs, ...syncJobs]);
}

export async function fanOutEntitlementChanged(
  event: EntitlementChangedEnvelope,
): Promise<{ enqueued: number; action: string }> {
  clearEntitlementCache(event.data.customer_id);
  const customerId = event.data.customer_id;
  const action = event.data.action;

  if (!Number.isInteger(customerId) || customerId <= 0) {
    console.info("entitlement_fan_out_skip", {
      event_id: event.event_id,
      reason: "missing_customer_id",
    });
    return { enqueued: 0, action };
  }

  const connections = await listConnectionsByCustomerId(customerId);
  if (connections.length === 0) {
    console.info("entitlement_fan_out_skip", {
      event_id: event.event_id,
      customer_id: customerId,
      reason: "no_connection",
    });
    return { enqueued: 0, action };
  }

  switch (action) {
    case "key_revoked": {
      let enqueued = 0;
      const flagsOff: ChannelPermissions = {
        can_view_designs: false,
        can_view_inventory: false,
        can_view_prices: false,
        can_place_orders: false,
      };
      for (const connection of connections) {
        const disabled = await refreshSyncFlagsFromPermissions(connection, flagsOff);
        enqueued += await deleteAllMappedDesigns(disabled);
      }
      console.info("entitlement_fan_out", {
        event_id: event.event_id,
        customer_id: customerId,
        action,
        enqueued,
      });
      return { enqueued, action };
    }

    case "revoke": {
      const entitlements = await fetchCustomerEntitlements(customerId, {
        fresh: true,
      });
      const designNos = event.data.design_nos.filter(
        (designNo) =>
          designNo.trim() && !designInFeed(entitlements, designNo),
      );
      const jobs: ProductSyncJob[] = connections.flatMap((connection) =>
        designNos.map((designNo) => ({
          kind: "product.sync" as const,
          connectionId: connection.id,
          platform: connection.platform,
          designNo,
          action: "delete" as const,
        })),
      );
      const enqueued = await enqueueJobs(jobs);
      console.info("entitlement_fan_out", {
        event_id: event.event_id,
        customer_id: customerId,
        action,
        enqueued,
      });
      return { enqueued, action };
    }

    case "grant": {
      let designNos = event.data.design_nos.filter((n) => n.trim());
      if (designNos.length === 0) {
        const ent = await fetchCustomerEntitlements(customerId, { fresh: true });
        if (!ent.key_present || !ent.permissions.can_view_designs) {
          return { enqueued: 0, action };
        }
        designNos = ent.design_nos;
      }
      const jobs: ProductSyncJob[] = connections
        .filter((connection) => connection.is_active && connection.sync_products)
        .flatMap((connection) =>
          designNos.map((designNo) => ({
            kind: "product.sync" as const,
            connectionId: connection.id,
            platform: connection.platform,
            designNo,
            action: "sync" as const,
          })),
        );
      const enqueued = await enqueueJobs(jobs);
      console.info("entitlement_fan_out", {
        event_id: event.event_id,
        customer_id: customerId,
        action,
        enqueued,
      });
      return { enqueued, action };
    }

    case "permissions_changed": {
      const ent = await fetchCustomerEntitlements(customerId, { fresh: true });
      const flagsOff: ChannelPermissions = {
        can_view_designs: false,
        can_view_inventory: false,
        can_view_prices: false,
        can_place_orders: false,
      };
      let enqueued = 0;
      for (const connection of connections) {
        const refreshed = await refreshSyncFlagsFromPermissions(
          connection,
          ent.key_present ? ent.permissions : flagsOff,
        );
        if (!ent.key_present || !ent.permissions.can_view_designs) {
          enqueued += await deleteAllMappedDesigns(refreshed);
        } else {
          enqueued += await reconcileFeed(refreshed, ent);
        }
      }
      console.info("entitlement_fan_out", {
        event_id: event.event_id,
        customer_id: customerId,
        action,
        enqueued,
        flags_refreshed: true,
      });
      return { enqueued, action };
    }

    default: {
      // Fail closed — never partial-delete unrelated designs on unknown action.
      console.info("entitlement_fan_out_skip", {
        event_id: event.event_id,
        customer_id: customerId,
        reason: "unknown_action",
        action,
      });
      return { enqueued: 0, action };
    }
  }
}
