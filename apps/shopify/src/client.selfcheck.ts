/**
 * Shopify client selfcheck — an empty cost bucket is waited out, not failed.
 *
 * Run: npm run selfcheck:client -w @devjewels-channels/shopify
 */
import { createShopifyClient, throttleWaitMs } from "./client";

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok  ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

const THROTTLED = {
  errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
  extensions: {
    cost: {
      requestedQueryCost: 352,
      throttleStatus: { currentlyAvailable: 52, restoreRate: 100 },
    },
  },
};

function reply(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function main(): Promise<void> {
  console.log("throttled: wait for the bucket, then retry");

  const waits: number[] = [];
  let calls = 0;
  const client = createShopifyClient({
    shopDomain: "merchant.myshopify.com",
    accessToken: "test-token",
    fetchImpl: (async () => {
      calls += 1;
      return calls < 3 ? reply(THROTTLED) : reply({ data: { ok: true } });
    }) as typeof fetch,
    sleepImpl: async (ms) => {
      waits.push(ms);
    },
  });
  const result = await client.graphql<{ ok: boolean }>("query q { shop { id } }");
  check("the call succeeds once the bucket refills", result.data?.ok === true, JSON.stringify(result));
  check("it was retried, not failed", calls === 3 && waits.length === 2, `calls=${calls}`);

  const wait = throttleWaitMs(THROTTLED);
  check(
    "the wait is what Shopify needs to refill this query's cost (300 points at 100/s)",
    wait >= 3000 && wait < 3250,
    String(wait),
  );
  check(
    "a huge cost never stalls a worker past the cap",
    throttleWaitMs({
      ...THROTTLED,
      extensions: {
        cost: {
          requestedQueryCost: 100_000,
          throttleStatus: { currentlyAvailable: 0, restoreRate: 50 },
        },
      },
    }) <= 10_250,
  );

  const backoff = [0, 1, 2, 3, 4, 5].map((a) =>
    throttleWaitMs(
      {
        ...THROTTLED,
        extensions: {
          cost: {
            requestedQueryCost: 10,
            throttleStatus: { currentlyAvailable: 5, restoreRate: 100 },
          },
        },
      },
      a,
    ),
  );
  check(
    "each retry waits longer, so a bucket shared with other workers can refill",
    backoff[0] >= 1000 && backoff[3] >= 8000 && backoff.every((w, i) => i === 0 || w >= backoff[i - 1] - 250),
    backoff.join(", "),
  );
  check(
    "six retries give the bucket at least half a minute",
    backoff.reduce((a, b) => a + b, 0) >= 30_000,
    String(backoff.reduce((a, b) => a + b, 0)),
  );

  console.log("throttled for good: give up, bounded");

  let stuckCalls = 0;
  const stuck = createShopifyClient({
    shopDomain: "merchant.myshopify.com",
    accessToken: "test-token",
    fetchImpl: (async () => {
      stuckCalls += 1;
      return reply(THROTTLED);
    }) as typeof fetch,
    sleepImpl: async () => {},
  });
  const gaveUp = await stuck.graphql("query q { shop { id } }");
  check(
    "returns the throttled error after a bounded number of tries",
    stuckCalls === 7 && gaveUp.errors?.[0]?.message === "Throttled",
    `calls=${stuckCalls}`,
  );

  console.log("other errors are not retried");

  let errorCalls = 0;
  const failing = createShopifyClient({
    shopDomain: "merchant.myshopify.com",
    accessToken: "test-token",
    fetchImpl: (async () => {
      errorCalls += 1;
      return reply({ errors: [{ message: "Field 'nope' doesn't exist" }] });
    }) as typeof fetch,
    sleepImpl: async () => {},
  });
  await failing.graphql("query q { nope }");
  check("a real GraphQL error comes back on the first try", errorCalls === 1);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nshopify client selfcheck passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
