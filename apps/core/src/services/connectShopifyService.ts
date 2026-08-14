/**
 * Staff connect flow: OAuth or paste shop + Admin API token → vault → connection + locations + webhooks.
 * Re-installing the same shop updates credentials (no duplicate connection).
 */
import {
  createConnection,
  getConnectionById,
  listConnections,
  setConnectionActive,
  updateConnectionCredentials,
  type ConnectionRow,
} from "@/services/connections";
import { runCatalogImport, type CatalogImportResult } from "@/services/catalogImportService";
import { writeVaultSecret } from "@/security/vault";
import { optionalProcessEnv } from "@/config/serverEnv";
import { resolveShopifyCredentials } from "@/security/secrets";
import {
  fetchShopifyLocations,
  shopifyClientFromCreds,
  getShopifyMetaStore,
  type ShopifyLocationRow,
} from "@devjewels-channels/shopify";
import {
  registerShopifyWebhooks,
  type RegisterShopifyWebhooksResult,
} from "@devjewels-channels/shopify/webhooks";
import { shopifyWebhookCallbackUrl } from "@devjewels-channels/shopify/auth";

function normalizeShopDomain(shop: string): string {
  return shop
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

export type ConnectShopifyInput = {
  name?: string;
  shopDomain: string;
  accessToken: string;
  /** Required: DevJewels Customer.pk — 1:1 shop ↔ customer */
  customerId: number;
  webhookSecret?: string;
  markupMode?: "none" | "percent" | "multiplier";
  markupValue?: number;
  /** Skip Shopify webhook API when public URL is unavailable (local-only). */
  skipWebhookRegistration?: boolean;
};

export type ConnectShopifyResult = {
  connection: ConnectionRow;
  shopDomain: string;
  locations: ShopifyLocationRow[];
  reconnected: boolean;
  webhooks: RegisterShopifyWebhooksResult[];
};

async function resolveWebhookSecret(explicit?: string): Promise<string | undefined> {
  const fromInput = explicit?.trim();
  if (fromInput) return fromInput;
  const fromEnv = optionalProcessEnv("SHOPIFY_API_SECRET");
  return fromEnv || undefined;
}

async function persistLocations(
  connectionId: string,
  remoteLocations: Array<{ id: string; name: string; isActive: boolean }>,
): Promise<ShopifyLocationRow[]> {
  const meta = getShopifyMetaStore();
  const previousPrimary = await meta.getPrimaryLocation(connectionId);
  const previousPrimaryId = previousPrimary?.external_location_id;

  const active = remoteLocations.filter((l) => l.isActive);
  const toSave = active.length > 0 ? active : remoteLocations;
  const locations: ShopifyLocationRow[] = [];
  for (let i = 0; i < toSave.length; i += 1) {
    const loc = toSave[i]!;
    const preferPrimary =
      previousPrimaryId != null
        ? loc.id === previousPrimaryId
        : i === 0;
    const row = await meta.upsertLocation({
      connectionId,
      externalLocationId: loc.id,
      name: loc.name,
      isPrimary: preferPrimary,
    });
    locations.push(row);
  }

  // If prior primary was removed remotely, ensure exactly one primary.
  if (!locations.some((l) => l.is_primary) && locations[0]) {
    locations[0] = await meta.upsertLocation({
      connectionId,
      externalLocationId: locations[0].external_location_id,
      name: locations[0].name,
      isPrimary: true,
    });
  }
  return locations;
}

async function registerWebhooksSafe(input: {
  connectionId: string;
  shopDomain: string;
  accessToken: string;
  skip?: boolean;
}): Promise<RegisterShopifyWebhooksResult[]> {
  if (input.skip) return [];
  let callbackUrl: string;
  try {
    callbackUrl = shopifyWebhookCallbackUrl();
  } catch {
    // Local without public URL: connect still succeeds; webhooks need CHANNELS_PUBLIC_BASE_URL.
    console.warn("shopify_webhook_register_skipped", {
      reason: "CHANNELS_PUBLIC_BASE_URL unset",
      shopDomain: input.shopDomain,
    });
    return [];
  }

  try {
    return await registerShopifyWebhooks({
      shopDomain: input.shopDomain,
      accessToken: input.accessToken,
      callbackUrl,
      connectionId: input.connectionId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "webhook register failed";
    console.warn("shopify_webhook_register_failed", {
      shopDomain: input.shopDomain,
      connectionId: input.connectionId,
      error: message,
    });
    // Public URL configured → treat as hard failure (merchant expects live order webhooks).
    throw new Error(
      "Connected, but Shopify webhook registration failed. Check CHANNELS_PUBLIC_BASE_URL is publicly reachable and app scopes include read_orders.",
    );
  }
}

export async function connectShopifyStore(
  input: ConnectShopifyInput,
): Promise<ConnectShopifyResult> {
  const shopDomain = normalizeShopDomain(input.shopDomain);
  const accessToken = input.accessToken.trim();
  const customerId = Number(input.customerId);
  if (!shopDomain.includes(".")) {
    throw new Error("Shop domain must look like your-store.myshopify.com");
  }
  if (!accessToken) {
    throw new Error("Admin API access token is required");
  }
  if (!Number.isInteger(customerId) || customerId <= 0) {
    throw new Error("customer_id is required to bind this Shopify store");
  }

  // Entitlement gate: active API key required before catalog/inventory sync.
  const { requireSyncableEntitlements } = await import("@/services/entitlements");
  const entitlements = await requireSyncableEntitlements(customerId);
  if (!entitlements) {
    throw new Error(
      "Customer needs an active API key with can_view_designs before connecting a channel",
    );
  }

  const meta = getShopifyMetaStore();
  const existingId = await meta.getConnectionIdByShopDomain(shopDomain);

  // Reject if shop already bound to a different customer.
  if (existingId) {
    const existingConn = await getConnectionById(existingId);
    if (
      existingConn?.customer_id != null &&
      existingConn.customer_id !== customerId
    ) {
      throw new Error(
        "This Shopify shop is already connected to another customer",
      );
    }
  }

  // Reject if customer already has a different shop.
  const existingByCustomer = await (
    await import("@/services/connections")
  ).getConnectionByCustomerId(customerId);
  if (
    existingByCustomer &&
    existingId &&
    existingByCustomer.id !== existingId
  ) {
    throw new Error("This customer already has a different channel connection");
  }
  if (existingByCustomer && !existingId) {
    throw new Error("This customer already has a channel connection");
  }

  // Validate token against Shopify before saving.
  const client = shopifyClientFromCreds({ shopDomain, accessToken });
  const remoteLocations = await fetchShopifyLocations(client);
  if (remoteLocations.length === 0) {
    throw new Error(
      "Shopify returned no locations — check token scopes (read_locations / read_inventory).",
    );
  }

  const webhookSecret = await resolveWebhookSecret(input.webhookSecret);
  const secretPayload: Record<string, string> = {
    accessToken,
    shopDomain,
  };
  if (webhookSecret) {
    secretPayload.webhookSecret = webhookSecret;
  }
  const credentialsSecretRef = await writeVaultSecret(secretPayload);

  const name =
    input.name?.trim() ||
    shopDomain.replace(/\.myshopify\.com$/i, "").replace(/\./g, " ") ||
    shopDomain;

  const markupMode = input.markupMode ?? "none";
  const markupValue = input.markupValue ?? 0;

  let connection: ConnectionRow;
  let reconnected = false;

  if (existingId) {
    const updated = await updateConnectionCredentials(existingId, credentialsSecretRef, {
      syncInventory: true,
      syncProducts: true,
      syncOrders: entitlements.permissions.can_place_orders,
      isActive: true,
      name: input.name?.trim() || undefined,
      customerId,
      markupMode,
      markupValue,
    });
    if (!updated) {
      throw new Error("Failed to update existing Shopify connection");
    }
    connection = updated;
    reconnected = true;
  } else {
    connection = await createConnection({
      platform: "SHOPIFY",
      name,
      credentialsSecretRef,
      customerId,
      markupMode,
      markupValue,
      syncInventory: true,
      syncPrice: true,
      syncProducts: true,
      syncOrders: entitlements.permissions.can_place_orders,
      isActive: true,
    });
    try {
      await meta.upsertShop(connection.id, shopDomain);
    } catch (err) {
      // UNIQUE(shop_domain) race / conflict — fail closed; deactivate orphan row.
      await setConnectionActive(connection.id, false).catch(() => null);
      throw err;
    }
  }

  const locations = await persistLocations(connection.id, remoteLocations);
  const webhooks = await registerWebhooksSafe({
    connectionId: connection.id,
    shopDomain,
    accessToken,
    skip: input.skipWebhookRegistration,
  });

  // Backfill entitled feed on first connect / reconnect.
  try {
    await runCatalogImport({
      connectionId: connection.id,
      maxDesigns: 200,
    });
  } catch (err) {
    console.warn("shopify_connect_backfill_failed", {
      connectionId: connection.id,
      error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
    });
  }

  return { connection, shopDomain, locations, reconnected, webhooks };
}

export async function setShopifyPrimaryLocation(
  connectionId: string,
  externalLocationId: string,
): Promise<ShopifyLocationRow> {
  const connection = await getConnectionById(connectionId);
  if (!connection || connection.platform !== "SHOPIFY") {
    throw new Error("Shopify connection not found");
  }
  return getShopifyMetaStore().upsertLocation({
    connectionId,
    externalLocationId,
    isPrimary: true,
  });
}

export async function refreshShopifyLocations(
  connectionId: string,
): Promise<ShopifyLocationRow[]> {
  const connection = await getConnectionById(connectionId);
  if (!connection || connection.platform !== "SHOPIFY") {
    throw new Error("Shopify connection not found");
  }
  if (!connection.credentials_secret_ref) {
    throw new Error("Connection has no credentials");
  }
  const meta = getShopifyMetaStore();
  const shop = await meta.getShop(connectionId);
  const creds = await resolveShopifyCredentials(
    connection.credentials_secret_ref,
    shop?.shop_domain,
  );
  const client = shopifyClientFromCreds(creds);
  const remote = await fetchShopifyLocations(client);
  return persistLocations(
    connectionId,
    remote.map((l) => ({ id: l.id, name: l.name, isActive: l.isActive })),
  );
}

export type ConnectionDetail = {
  connection: ConnectionRow;
  shopDomain: string | null;
  locations: ShopifyLocationRow[];
};

export async function getConnectionDetail(
  connectionId: string,
): Promise<ConnectionDetail | null> {
  const connection = await getConnectionById(connectionId);
  if (!connection) return null;
  const meta = getShopifyMetaStore();
  const shop = await meta.getShop(connectionId);
  const locations =
    connection.platform === "SHOPIFY"
      ? await meta.listLocations(connectionId)
      : [];
  return {
    connection,
    shopDomain: shop?.shop_domain ?? null,
    locations,
  };
}

export async function listConnectionDetails(): Promise<ConnectionDetail[]> {
  const rows = await listConnections(100);
  const out: ConnectionDetail[] = [];
  for (const connection of rows) {
    const detail = await getConnectionDetail(connection.id);
    if (detail) out.push(detail);
  }
  return out;
}

export async function importCatalogForConnection(
  connectionId: string,
  maxDesigns = 50,
): Promise<CatalogImportResult> {
  const connection = await getConnectionById(connectionId);
  if (!connection) {
    throw new Error("Connection not found");
  }
  if (!connection.is_active) {
    throw new Error("Connection is inactive");
  }
  return runCatalogImport({
    connectionId,
    maxDesigns: Math.min(Math.max(maxDesigns, 1), 500),
  });
}
