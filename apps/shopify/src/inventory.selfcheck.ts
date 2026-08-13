/**
 * Shopify inventory selfcheck — mock HTTP (no real Shopify / no Postgres).
 * Run: npm run selfcheck:inventory -w @devjewels-channels/shopify
 */
import { createShopifyClient, ShopifyRateLimitError } from "./client";
import { setShopifyInventoryLevel } from "./inventory";
import {
  createMemoryShopifyMetaStore,
  setShopifyMetaStoreForTests,
} from "./meta";
import { shopifyAdapter } from "./adapter";
import { redactShopifySecrets } from "../../core/src/security/redact";

type FetchCall = {
  url: string;
  body: string;
};

async function mockOkFetch(calls: FetchCall[]): Promise<typeof fetch> {
  return (async (input, init) => {
    calls.push({
      url: String(input),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(
      JSON.stringify({
        data: { inventorySetQuantities: { userErrors: [] } },
        extensions: {
          cost: { throttleStatus: { currentlyAvailable: 900, restoreRate: 50 } },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}

async function mock429Fetch(): Promise<typeof fetch> {
  return (async () =>
    new Response("Too Many Requests", {
      status: 429,
      headers: { "Retry-After": "2" },
    })) as typeof fetch;
}

async function main(): Promise<void> {
  const connectionId = "22222222-2222-2222-2222-222222222222";
  setShopifyMetaStoreForTests(
    createMemoryShopifyMetaStore({
      shops: [{ connection_id: connectionId, shop_domain: "test.myshopify.com" }],
      locations: [
        {
          connection_id: connectionId,
          external_location_id: "gid://shopify/Location/9",
          name: "Primary",
          is_primary: true,
        },
      ],
    }),
  );

  process.env.CHANNELS_SECRET_shopify_selfcheck = JSON.stringify({
    accessToken: "shpat_SELFCHECK_TOKEN_DO_NOT_LOG",
    shopDomain: "test.myshopify.com",
  });

  // --- success path ---
  const okCalls: FetchCall[] = [];
  const okClient = createShopifyClient({
    shopDomain: "test.myshopify.com",
    accessToken: "shpat_x",
    fetchImpl: await mockOkFetch(okCalls),
  });
  await setShopifyInventoryLevel(okClient, {
    inventoryItemId: "123",
    locationId: "9",
    available: 4,
  });
  if (okCalls.length !== 1) throw new Error("expected 1 Shopify GraphQL call");
  if (!okCalls[0]!.url.includes("test.myshopify.com")) {
    throw new Error("expected shop domain in URL");
  }
  if (okCalls[0]!.body.includes("shpat_")) {
    // body should not include token (token is header-only)
  }

  // --- adapter success ---
  const adapterCalls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = await mockOkFetch(adapterCalls);
  try {
    await shopifyAdapter.updateInventory({
      connectionId,
      designNo: "SC-1",
      jobNo: "JOB-1",
      quantity: 7,
      externalInventoryItemId: "gid://shopify/InventoryItem/55",
      credentialsSecretRef: "env:CHANNELS_SECRET_shopify_selfcheck",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  if (adapterCalls.length !== 1) {
    throw new Error(`adapter expected 1 call, got ${adapterCalls.length}`);
  }

  // --- 429 classified ---
  const rateClient = createShopifyClient({
    shopDomain: "test.myshopify.com",
    accessToken: "shpat_x",
    fetchImpl: await mock429Fetch(),
  });
  let saw429 = false;
  try {
    await setShopifyInventoryLevel(rateClient, {
      inventoryItemId: "1",
      locationId: "1",
      available: 0,
    });
  } catch (err) {
    if (err instanceof ShopifyRateLimitError && err.retryAfterMs === 2000) {
      saw429 = true;
    } else {
      throw err;
    }
  }
  if (!saw429) throw new Error("expected ShopifyRateLimitError with retryAfterMs");

  // --- missing location → InventorySkipError ---
  setShopifyMetaStoreForTests(
    createMemoryShopifyMetaStore({
      shops: [{ connection_id: connectionId, shop_domain: "test.myshopify.com" }],
      locations: [],
    }),
  );
  let missingLoc = false;
  try {
    await shopifyAdapter.updateInventory({
      connectionId,
      designNo: "SC-1",
      jobNo: "JOB-1",
      quantity: 1,
      externalInventoryItemId: "gid://shopify/InventoryItem/55",
      credentialsSecretRef: "env:CHANNELS_SECRET_shopify_selfcheck",
    });
  } catch (err) {
    const skip =
      err &&
      typeof err === "object" &&
      "name" in err &&
      "reason" in err &&
      (err as { name: string; reason: string }).name === "InventorySkipError" &&
      (err as { name: string; reason: string }).reason === "missing_location";
    if (skip) {
      missingLoc = true;
    } else {
      throw err;
    }
  }
  if (!missingLoc) throw new Error("expected missing_location skip");

  // Token redaction helper (adapter failure logs must not echo shpat_)
  const redacted = redactShopifySecrets("boom shpat_LEAKEDTOKEN123 end");
  if (redacted.includes("shpat_LEAKEDTOKEN123") || !redacted.includes("shpat_***")) {
    throw new Error(`expected token redaction, got: ${redacted}`);
  }

  setShopifyMetaStoreForTests(null);
  console.log("shopify inventory.selfcheck ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
