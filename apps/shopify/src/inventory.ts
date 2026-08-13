/**
 * Shopify inventory Admin API helpers (GraphQL inventorySetQuantities).
 */
import type { ShopifyAdminClient } from "./client";
import { ShopifyHttpError } from "./client";

export type SetShopifyInventoryLevelInput = {
  inventoryItemId: string;
  locationId: string;
  available: number;
};

function toGid(resource: "InventoryItem" | "Location", id: string): string {
  const trimmed = id.trim();
  if (trimmed.startsWith("gid://")) return trimmed;
  return `gid://shopify/${resource}/${trimmed}`;
}

const SET_QUANTITIES = /* GraphQL */ `
  mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export async function setShopifyInventoryLevel(
  client: ShopifyAdminClient,
  input: SetShopifyInventoryLevelInput,
): Promise<void> {
  const inventoryItemId = toGid("InventoryItem", input.inventoryItemId);
  const locationId = toGid("Location", input.locationId);
  const quantity = Math.trunc(input.available);
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new ShopifyHttpError(400, `Invalid inventory quantity: ${input.available}`);
  }

  const result = await client.graphql<{
    inventorySetQuantities?: {
      userErrors?: Array<{ field?: string[]; message: string; code?: string }>;
    };
  }>(SET_QUANTITIES, {
    input: {
      name: "available",
      reason: "correction",
      ignoreCompareQuantity: true,
      quantities: [
        {
          inventoryItemId,
          locationId,
          quantity,
        },
      ],
    },
  });

  if (result.errors?.length) {
    throw new ShopifyHttpError(
      502,
      result.errors.map((e) => e.message).join("; ") || "Shopify GraphQL errors",
    );
  }

  const userErrors = result.data?.inventorySetQuantities?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new ShopifyHttpError(
      422,
      userErrors.map((e) => e.message).join("; ") || "inventorySetQuantities userErrors",
    );
  }
}
