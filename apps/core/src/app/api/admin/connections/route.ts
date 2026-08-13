import { assertAdminRequest, jsonError } from "@/security/dashboardAuth";
import { listConnectionDetails } from "@/services/connectShopifyService";

export async function GET(req: Request) {
  try {
    await assertAdminRequest(req);
    const connections = await listConnectionDetails();
    return Response.json({
      connections: connections.map((c) => ({
        id: c.connection.id,
        name: c.connection.name,
        platform: c.connection.platform,
        is_active: c.connection.is_active,
        customer_id: c.connection.customer_id,
        markup_mode: c.connection.markup_mode,
        markup_value: c.connection.markup_value,
        sync_inventory: c.connection.sync_inventory,
        sync_products: c.connection.sync_products,
        shop_domain: c.shopDomain,
        locations: c.locations,
        primary_location_id:
          c.locations.find((l) => l.is_primary)?.external_location_id ?? null,
      })),
    });
  } catch (err) {
    return jsonError(err);
  }
}
