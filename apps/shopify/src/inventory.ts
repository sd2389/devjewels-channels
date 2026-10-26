/**
 * Shopify inventory Admin API helpers (GraphQL inventorySetQuantities + cost).
 */
import type { ShopifyAdminClient } from "./client";
import { ShopifyHttpError } from "./client";

export type SetShopifyInventoryLevelInput = {
  inventoryItemId: string;
  locationId: string;
  available: number;
};

export type SetShopifyInventoryCostInput = {
  inventoryItemId: string;
  /** Wholesale unit cost in the shop currency. Not the selling price. */
  cost: number;
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

const INVENTORY_ITEM_UPDATE = /* GraphQL */ `
  mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      userErrors {
        field
        message
      }
    }
  }
`;

function throwGraphqlOrUserErrors(
  errors: Array<{ message: string }> | undefined,
  userErrors: Array<{ message: string }> | undefined,
  label: string,
): void {
  if (errors?.length) {
    throw new ShopifyHttpError(
      502,
      errors.map((e) => e.message).join("; ") || "Shopify GraphQL errors",
    );
  }
  if (userErrors?.length) {
    throw new ShopifyHttpError(
      422,
      userErrors.map((e) => e.message).join("; ") || `${label} userErrors`,
    );
  }
}

/** Writes inventoryItem.unitCost only — never product price or content. */
export async function setShopifyInventoryCost(
  client: ShopifyAdminClient,
  input: SetShopifyInventoryCostInput,
): Promise<void> {
  const inventoryItemId = toGid("InventoryItem", input.inventoryItemId);
  const cost = Number(input.cost);
  if (!Number.isFinite(cost) || cost < 0) {
    throw new ShopifyHttpError(400, `Invalid inventory cost: ${input.cost}`);
  }
  const result = await client.graphql<{
    inventoryItemUpdate?: {
      userErrors?: Array<{ field?: string[]; message: string }>;
    };
  }>(INVENTORY_ITEM_UPDATE, {
    id: inventoryItemId,
    input: { cost: cost.toFixed(2) },
  });
  throwGraphqlOrUserErrors(
    result.errors,
    result.data?.inventoryItemUpdate?.userErrors,
    "inventoryItemUpdate",
  );
}

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

  throwGraphqlOrUserErrors(
    result.errors,
    result.data?.inventorySetQuantities?.userErrors,
    "inventorySetQuantities",
  );
}
