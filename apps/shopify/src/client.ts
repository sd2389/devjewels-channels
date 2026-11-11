/**
 * Shopify Admin GraphQL client.
 * Callers resolve tokens via secret refs before constructing a client.
 * Never log access tokens.
 */

export type ShopifyClientConfig = {
  shopDomain: string;
  /** Resolved token — do not log. */
  accessToken: string;
  apiVersion?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Injected in selfchecks so throttle backoff does not really wait. */
  sleepImpl?: (ms: number) => Promise<void>;
};

export type ShopifyGraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: {
    cost?: {
      requestedQueryCost?: number;
      throttleStatus?: {
        currentlyAvailable?: number;
        restoreRate?: number;
      };
    };
  };
};

export class ShopifyHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "ShopifyHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export class ShopifyRateLimitError extends ShopifyHttpError {
  constructor(retryAfterMs?: number) {
    super(429, "Shopify rate limited", retryAfterMs);
    this.name = "ShopifyRateLimitError";
  }
}

export type ShopifyAdminClient = {
  readonly shopDomain: string;
  graphql: <T>(
    query: string,
    variables?: Record<string, unknown>,
  ) => Promise<ShopifyGraphqlResponse<T>>;
};

function normalizeShopDomain(shopDomain: string): string {
  const trimmed = shopDomain.trim().toLowerCase().replace(/^https?:\/\//, "");
  return trimmed.replace(/\/$/, "");
}

/**
 * Shopify answers an empty cost bucket with HTTP 200 and a THROTTLED error, not
 * a 429. Retried here, in the one place every call goes through, so a catalog
 * import that outruns the bucket waits for it to refill instead of failing
 * every design after the first few seconds.
 */
const THROTTLE_MAX_RETRIES = 6;
const THROTTLE_MIN_WAIT_MS = 500;
const THROTTLE_MAX_WAIT_MS = 10_000;

function isThrottled<T>(body: ShopifyGraphqlResponse<T>): boolean {
  return (body.errors ?? []).some(
    (e) =>
      String(e.extensions?.code || "").toUpperCase() === "THROTTLED" ||
      /^throttled$/i.test(String(e.message || "").trim()),
  );
}

/** Time for the bucket to hold this query's cost again, from Shopify's own numbers. */
export function throttleWaitMs<T>(body: ShopifyGraphqlResponse<T>): number {
  const cost = body.extensions?.cost;
  const requested = Number(cost?.requestedQueryCost ?? 0);
  const available = Number(cost?.throttleStatus?.currentlyAvailable ?? 0);
  const restoreRate = Number(cost?.throttleStatus?.restoreRate ?? 0);
  const needed =
    restoreRate > 0 && requested > available
      ? Math.ceil(((requested - available) / restoreRate) * 1000)
      : 1000;
  // Jitter so workers that ran dry together do not all come back on one tick.
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(THROTTLE_MAX_WAIT_MS, Math.max(THROTTLE_MIN_WAIT_MS, needed)) + jitter;
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const asInt = Number.parseInt(header, 10);
  if (Number.isFinite(asInt) && asInt >= 0) return asInt * 1000;
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) {
    return Math.max(0, asDate - Date.now());
  }
  return undefined;
}

export function createShopifyClient(config: ShopifyClientConfig): ShopifyAdminClient {
  const shopDomain = normalizeShopDomain(config.shopDomain);
  if (!shopDomain) {
    throw new Error("shopDomain is required");
  }
  if (!config.accessToken?.trim()) {
    throw new Error("accessToken is required");
  }

  const apiVersion = config.apiVersion ?? process.env.SHOPIFY_API_VERSION ?? "2025-01";
  const timeoutMs = config.timeoutMs ?? 10_000;
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const sleep =
    config.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;

  async function send<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<ShopifyGraphqlResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": config.accessToken,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError"
          ? `Shopify GraphQL timeout after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : "Shopify GraphQL request failed";
      throw new ShopifyHttpError(0, message);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      throw new ShopifyRateLimitError(
        parseRetryAfterMs(response.headers.get("retry-after")),
      );
    }

    if (!response.ok) {
      throw new ShopifyHttpError(
        response.status,
        `Shopify GraphQL HTTP ${response.status}`,
      );
    }

    const body = (await response.json()) as ShopifyGraphqlResponse<T>;
    const throttle = body.extensions?.cost?.throttleStatus;
    if (throttle) {
      console.info("shopify_throttle_status", {
        shopDomain,
        currentlyAvailable: throttle.currentlyAvailable,
        restoreRate: throttle.restoreRate,
      });
    }
    return body;
  }

  return {
    shopDomain,
    async graphql<T>(query: string, variables?: Record<string, unknown>) {
      for (let attempt = 0; ; attempt += 1) {
        const body = await send<T>(query, variables);
        if (!isThrottled(body) || attempt >= THROTTLE_MAX_RETRIES) return body;
        const waitMs = throttleWaitMs(body);
        console.info("shopify_throttled_retry", { shopDomain, attempt: attempt + 1, waitMs });
        await sleep(waitMs);
      }
    },
  };
}
