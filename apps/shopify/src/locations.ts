/**
 * Fetch Shopify locations via Admin GraphQL (for connect wizard).
 */
import { createShopifyClient, type ShopifyAdminClient } from "./client";

export type ShopifyRemoteLocation = {
  id: string;
  name: string;
  isActive: boolean;
};

const LOCATIONS_QUERY = `#graphql
  query ChannelsLocations($first: Int!) {
    locations(first: $first) {
      edges {
        node {
          id
          name
          isActive
        }
      }
    }
  }
`;

export async function fetchShopifyLocations(
  client: ShopifyAdminClient,
): Promise<ShopifyRemoteLocation[]> {
  const res = await client.graphql<{
    locations?: {
      edges?: Array<{ node?: { id?: string; name?: string; isActive?: boolean } }>;
    };
  }>(LOCATIONS_QUERY, { first: 50 });

  if (res.errors?.length) {
    throw new Error(res.errors.map((e) => e.message).join("; ") || "Shopify locations query failed");
  }

  const edges = res.data?.locations?.edges ?? [];
  return edges
    .map((edge) => edge.node)
    .filter((node): node is { id: string; name: string; isActive: boolean } =>
      Boolean(node?.id && node.name != null),
    )
    .map((node) => ({
      id: node.id,
      name: node.name,
      isActive: node.isActive !== false,
    }));
}

export function shopifyClientFromCreds(input: {
  shopDomain: string;
  accessToken: string;
}): ShopifyAdminClient {
  return createShopifyClient({
    shopDomain: input.shopDomain,
    accessToken: input.accessToken,
  });
}
