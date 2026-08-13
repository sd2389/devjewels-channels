/**
 * Entitlement-changed fan-out: customer-scoped grant / revoke / key_revoked /
 * permissions_changed. Customer API is SoT — no local design allowlist.
 */
import {
  getConnectionByCustomerId,
  updateConnectionCredentials,
  type ConnectionRow,
} from "@/services/connections";
import {
  clearEntitlementCache,
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
  const ref = connection.credentials_secret_ref?.trim();
  if (!ref) {
    return connection;
  }
  const updated = await updateConnectionCredentials(connection.id, ref, {
    syncOrders: permissions.can_place_orders,
    syncInventory: permissions.can_view_inventory,
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
    connection.sync_products
      ? ent.design_nos.slice(0, 500).map((designNo) => ({
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
  clearEntitlementCache();
  const customerId = event.data.customer_id;
  const action = event.data.action;

  if (!Number.isInteger(customerId) || customerId <= 0) {
    console.info("entitlement_fan_out_skip", {
      event_id: event.event_id,
      reason: "missing_customer_id",
    });
    return { enqueued: 0, action };
  }

  const connection = await getConnectionByCustomerId(customerId);
  if (!connection || !connection.is_active) {
    console.info("entitlement_fan_out_skip", {
      event_id: event.event_id,
      customer_id: customerId,
      reason: connection ? "inactive" : "no_connection",
    });
    return { enqueued: 0, action };
  }

  switch (action) {
    case "key_revoked": {
      const enqueued = await deleteAllMappedDesigns(connection);
      console.info("entitlement_fan_out", {
        event_id: event.event_id,
        customer_id: customerId,
        action,
        enqueued,
      });
      return { enqueued, action };
    }

    case "revoke": {
      const designNos = event.data.design_nos.filter((n) => n.trim());
      const jobs: ProductSyncJob[] = designNos.map((designNo) => ({
        kind: "product.sync",
        connectionId: connection.id,
        platform: connection.platform,
        designNo,
        action: "delete",
      }));
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
        const ent = await fetchCustomerEntitlements(customerId);
        if (!ent.key_present || !ent.permissions.can_view_designs) {
          return { enqueued: 0, action };
        }
        designNos = ent.design_nos;
      }
      if (!connection.sync_products) {
        return { enqueued: 0, action };
      }
      const jobs: ProductSyncJob[] = designNos.slice(0, 500).map((designNo) => ({
        kind: "product.sync",
        connectionId: connection.id,
        platform: connection.platform,
        designNo,
        action: "sync",
      }));
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
      const ent = await fetchCustomerEntitlements(customerId);
      const flagsOff: ChannelPermissions = {
        can_view_designs: false,
        can_view_inventory: false,
        can_view_prices: false,
        can_place_orders: false,
      };
      const refreshed = await refreshSyncFlagsFromPermissions(
        connection,
        ent.key_present ? ent.permissions : flagsOff,
      );

      if (!ent.key_present || !ent.permissions.can_view_designs) {
        const enqueued = await deleteAllMappedDesigns(refreshed);
        console.info("entitlement_fan_out", {
          event_id: event.event_id,
          customer_id: customerId,
          action,
          enqueued,
          flags_refreshed: true,
        });
        return { enqueued, action };
      }

      const enqueued = await reconcileFeed(refreshed, ent);
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
