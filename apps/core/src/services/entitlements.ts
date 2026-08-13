/**
 * Customer entitlement client — Django channels_api is SoT.
 * Channels never stores a design allowlist; it always asks Django.
 */
import { DeverpHttpError, deverpClient } from "@/integrations/deverp/client";

export type ChannelPermissions = {
  can_view_designs: boolean;
  can_view_inventory: boolean;
  can_view_prices: boolean;
  can_place_orders: boolean;
};

export type CustomerEntitlements = {
  customer_id: number;
  key_present: boolean;
  api_key_id: number | null;
  permissions: ChannelPermissions;
  design_nos: string[];
  design_count: number;
  design_nos_truncated: boolean;
};

const EMPTY_PERMS: ChannelPermissions = {
  can_view_designs: false,
  can_view_inventory: false,
  can_view_prices: false,
  can_place_orders: false,
};

/** Short TTL in-process cache to avoid stampede on multi-design fan-out. */
const cache = new Map<number, { at: number; value: CustomerEntitlements }>();
const CACHE_TTL_MS = 15_000;

export function clearEntitlementCache(): void {
  cache.clear();
}

export async function fetchCustomerEntitlements(
  customerId: number,
): Promise<CustomerEntitlements> {
  const cached = cache.get(customerId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }
  const value = await deverpClient.getEntitlements(customerId);
  cache.set(customerId, { at: Date.now(), value });
  return value;
}

export function emptyEntitlements(customerId: number): CustomerEntitlements {
  return {
    customer_id: customerId,
    key_present: false,
    api_key_id: null,
    permissions: { ...EMPTY_PERMS },
    design_nos: [],
    design_count: 0,
    design_nos_truncated: false,
  };
}

export async function requireSyncableEntitlements(
  customerId: number | null | undefined,
): Promise<CustomerEntitlements | null> {
  if (customerId == null || !Number.isInteger(customerId) || customerId <= 0) {
    return null;
  }
  try {
    const ent = await fetchCustomerEntitlements(customerId);
    if (!ent.key_present || !ent.permissions.can_view_designs) {
      return null;
    }
    return ent;
  } catch (err) {
    if (err instanceof DeverpHttpError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

export function designInFeed(
  entitlements: CustomerEntitlements,
  designNo: string,
): boolean {
  const want = designNo.trim().toUpperCase().replace(/\s+/g, "");
  if (!want) return false;
  return entitlements.design_nos.some(
    (n) => n.trim().toUpperCase().replace(/\s+/g, "") === want,
  );
}

export async function filterEntitledCustomerIds(input: {
  designNo: string;
  customerIds: number[];
  requirePermission?: keyof ChannelPermissions;
}): Promise<Array<{ customer_id: number; permissions: ChannelPermissions }>> {
  if (input.customerIds.length === 0) return [];
  const result = await deverpClient.checkEntitlements({
    designNo: input.designNo,
    customerIds: input.customerIds,
    requirePermission: input.requirePermission ?? "can_view_designs",
  });
  return result.entitled;
}
