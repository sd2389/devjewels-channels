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
};

export type ShopifyGraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
  extensions?: {
    cost?: {
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
  const url = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;

  return {
    shopDomain,
    async graphql<T>(query: string, variables?: Record<string, unknown>) {
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
    },
  };
}
