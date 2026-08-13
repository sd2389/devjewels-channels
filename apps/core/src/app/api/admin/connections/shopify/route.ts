import { assertAdminRequest, jsonError } from "@/security/dashboardAuth";
import { connectShopifyStore } from "@/services/connectShopifyService";

export async function POST(req: Request) {
  try {
    await assertAdminRequest(req);
    const body = (await req.json()) as {
      name?: string;
      shopDomain?: string;
      accessToken?: string;
      webhookSecret?: string;
      customerId?: number;
      markupMode?: "none" | "percent" | "multiplier";
      markupValue?: number;
    };
    const customerId = Number(body.customerId);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return Response.json(
        { error: "customer_id is required (DevJewels Customer.pk)" },
        { status: 400 },
      );
    }
    const result = await connectShopifyStore({
      name: body.name,
      shopDomain: String(body.shopDomain || ""),
      accessToken: String(body.accessToken || ""),
      webhookSecret: body.webhookSecret,
      customerId,
      markupMode: body.markupMode,
      markupValue: body.markupValue,
    });
    return Response.json(
      {
        connection: {
          id: result.connection.id,
          name: result.connection.name,
          platform: result.connection.platform,
          is_active: result.connection.is_active,
          customer_id: result.connection.customer_id,
          markup_mode: result.connection.markup_mode,
          markup_value: result.connection.markup_value,
          sync_inventory: result.connection.sync_inventory,
          sync_products: result.connection.sync_products,
        },
        shop_domain: result.shopDomain,
        locations: result.locations,
        reconnected: result.reconnected,
        webhooks_registered: result.webhooks.length,
      },
      { status: result.reconnected ? 200 : 201 },
    );
  } catch (err) {
    return jsonError(err);
  }
}
