/**
 * HTTP client for the DevJewels store API — the Django `channels_api` facades
 * in the devjewels-backend repo, reached at DEVJEWELS_API_BASE_URL
 * (storeapi.devjewels.com in production). This is the source of truth for
 * designs, inventory, prices, entitlements and order reserve.
 *
 * Channels must never query public tables — only these endpoints.
 *
 * Formerly named `deverp`, after the legacy repo this stack replaced. Nothing
 * here talks to that system; the env var keeps its name because it is wired
 * into Infisical and the SST deploy.
 */

import { requiredServerEnv } from "../../config/serverEnv";

export type StoreApiInventoryJob = {
  design_no: string;
  job_no: string;
  totamt?: string | number;
  [key: string]: unknown;
};

export type StoreApiInventory = {
  design_no: string;
  job_no: string | null;
  available_count: number;
  truncated: boolean;
  jobs: StoreApiInventoryJob[];
};

export type StoreApiPrice = {
  customer_id: number;
  design_no: string;
  job_no?: string | null;
  sku?: string;
  original_price: number;
  final_price: number;
  currency: string;
};

export type StoreApiProduct = {
  id: number;
  design_no: string;
  titleline?: string;
  totamt?: string;
  [key: string]: unknown;
};

export type StoreApiCatalogPage = {
  items: StoreApiProduct[];
  limit: number;
  after_id: number | null;
  next_after_id: number | null;
  has_more: boolean;
  count: number;
  customer_id?: number;
};

export type StoreApiEntitlements = {
  customer_id: number;
  key_present: boolean;
  api_key_id: number | null;
  permissions: {
    can_view_designs: boolean;
    can_view_inventory: boolean;
    can_view_prices: boolean;
    can_place_orders: boolean;
  };
  design_nos: string[];
  design_count: number;
  design_nos_truncated: boolean;
};

export type StoreApiEntitlementCheckResult = {
  design_no: string;
  entitled: Array<{
    customer_id: number;
    permissions: StoreApiEntitlements["permissions"];
  }>;
  count: number;
};

export type StoreApiReserveOrderPayload = {
  platform: "SHOPIFY" | "WOOCOMMERCE" | "MAGENTO";
  connection_id: string;
  customer_id: number;
  external_order_id: string;
  currency?: string;
  customer_email?: string;
  customer_name?: string;
  lines: Array<{
    design_no: string;
    job_no: string;
    quantity: number;
    unit_price?: string | number;
    external_line_id?: string;
  }>;
};

export type StoreApiReserveOrderResult = {
  order_id: number;
  order_number: string;
  duplicate: boolean;
  platform: string;
  external_order_id: string;
  connection_id: string;
};

export type ChannelsCustomerHit = {
  id: number;
  name: string;
  email: string;
  has_active_api_key: boolean;
};

export type ChannelsCustomerPage = {
  items: ChannelsCustomerHit[];
  limit: number;
  offset: number;
  total: number;
  has_more: boolean;
};

const CUSTOMER_Q_MAX_LEN = 100;

export type StoreApiClient = {
  listCatalogDesigns(input: {
    customerId: number;
    limit?: number;
    afterId?: number | null;
  }): Promise<StoreApiCatalogPage>;
  getProduct(designNo: string, customerId?: number): Promise<StoreApiProduct>;
  getInventory(designNo: string, jobNo?: string): Promise<StoreApiInventory>;
  getPrice(input: {
    customerId: number;
    designNo: string;
    jobNo?: string;
  }): Promise<StoreApiPrice>;
  getEntitlements(customerId: number): Promise<StoreApiEntitlements>;
  checkEntitlements(input: {
    designNo: string;
    customerIds: number[];
    requirePermission?: string;
  }): Promise<StoreApiEntitlementCheckResult>;
  reserveOrder(payload: StoreApiReserveOrderPayload): Promise<StoreApiReserveOrderResult>;
};

export class StoreApiHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "StoreApiHttpError";
    this.status = status;
    this.body = body;
  }
}

function apiBase(): string {
  return requiredServerEnv("DEVJEWELS_API_BASE_URL").replace(/\/$/, "");
}

function serviceHeaders(): HeadersInit {
  const token = requiredServerEnv("CHANNELS_SERVICE_TOKEN");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function unwrapData<T>(body: unknown, status: number): T {
  if (!body || typeof body !== "object") {
    throw new StoreApiHttpError(status, "Invalid channels_api response");
  }
  const obj = body as { success?: boolean; data?: T; error?: string };
  if (obj.success === false) {
    throw new StoreApiHttpError(status, obj.error || "channels_api error", body);
  }
  if (obj.data === undefined) {
    throw new StoreApiHttpError(status, "channels_api missing data", body);
  }
  return obj.data;
}

let overrideClient: StoreApiClient | null = null;

export function setStoreApiClientForTests(client: StoreApiClient | null): void {
  overrideClient = client;
}

export function createHttpStoreApiClient(
  fetchImpl: typeof fetch = globalThis.fetch,
): StoreApiClient {
  return {
    async listCatalogDesigns(input) {
      const params = new URLSearchParams();
      params.set("customer_id", String(input.customerId));
      if (input.limit != null) params.set("limit", String(input.limit));
      if (input.afterId != null) params.set("after_id", String(input.afterId));
      const url = `${apiBase()}/api/v1/internal/channels/products/?${params}`;
      const response = await fetchImpl(url, {
        method: "GET",
        headers: serviceHeaders(),
      });
      const body = await parseJson(response);
      if (!response.ok) {
        throw new StoreApiHttpError(
          response.status,
          `listCatalogDesigns HTTP ${response.status}`,
          body,
        );
      }
      return unwrapData<StoreApiCatalogPage>(body, response.status);
    },

    async getProduct(designNo, customerId) {
      const params = new URLSearchParams({ design_no: designNo });
      if (customerId != null) params.set("customer_id", String(customerId));
      const url = `${apiBase()}/api/v1/internal/channels/products/?${params}`;
      const response = await fetchImpl(url, {
        method: "GET",
        headers: serviceHeaders(),
      });
      const body = await parseJson(response);
      if (!response.ok) {
        throw new StoreApiHttpError(
          response.status,
          `getProduct HTTP ${response.status}`,
          body,
        );
      }
      return unwrapData<StoreApiProduct>(body, response.status);
    },

    async getInventory(designNo, jobNo) {
      const params = new URLSearchParams({ design_no: designNo });
      if (jobNo) params.set("job_no", jobNo);
      const url = `${apiBase()}/api/v1/internal/channels/inventory/?${params}`;
      const response = await fetchImpl(url, {
        method: "GET",
        headers: serviceHeaders(),
      });
      const body = await parseJson(response);
      if (!response.ok) {
        throw new StoreApiHttpError(
          response.status,
          `getInventory HTTP ${response.status}`,
          body,
        );
      }
      return unwrapData<StoreApiInventory>(body, response.status);
    },

    async getPrice(input) {
      const params = new URLSearchParams({
        customer_id: String(input.customerId),
        design_no: input.designNo,
      });
      if (input.jobNo) params.set("job_no", input.jobNo);
      const url = `${apiBase()}/api/v1/internal/channels/price/?${params}`;
      const response = await fetchImpl(url, {
        method: "GET",
        headers: serviceHeaders(),
      });
      const body = await parseJson(response);
      if (!response.ok) {
        throw new StoreApiHttpError(
          response.status,
          `getPrice HTTP ${response.status}`,
          body,
        );
      }
      return unwrapData<StoreApiPrice>(body, response.status);
    },

    async getEntitlements(customerId) {
      const url = `${apiBase()}/api/v1/internal/channels/entitlements/?customer_id=${encodeURIComponent(String(customerId))}`;
      const response = await fetchImpl(url, {
        method: "GET",
        headers: serviceHeaders(),
      });
      const body = await parseJson(response);
      if (!response.ok) {
        throw new StoreApiHttpError(
          response.status,
          `getEntitlements HTTP ${response.status}`,
          body,
        );
      }
      return unwrapData<StoreApiEntitlements>(body, response.status);
    },

    async checkEntitlements(input) {
      const url = `${apiBase()}/api/v1/internal/channels/entitlements/check/`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: serviceHeaders(),
        body: JSON.stringify({
          design_no: input.designNo,
          customer_ids: input.customerIds,
          require_permission: input.requirePermission,
        }),
      });
      const body = await parseJson(response);
      if (!response.ok) {
        throw new StoreApiHttpError(
          response.status,
          `checkEntitlements HTTP ${response.status}`,
          body,
        );
      }
      return unwrapData<StoreApiEntitlementCheckResult>(body, response.status);
    },

    async reserveOrder(payload) {
      const url = `${apiBase()}/api/v1/internal/channels/orders/reserve`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: serviceHeaders(),
        body: JSON.stringify(payload),
      });
      const body = await parseJson(response);
      if (!response.ok) {
        const errMsg =
          body &&
          typeof body === "object" &&
          "error" in body &&
          typeof (body as { error: unknown }).error === "string"
            ? (body as { error: string }).error
            : `reserveOrder HTTP ${response.status}`;
        throw new StoreApiHttpError(response.status, errMsg, body);
      }
      return unwrapData<StoreApiReserveOrderResult>(body, response.status);
    },
  };
}

export async function listChannelsCustomers(
  input: { q?: string; limit?: number; offset?: number } = {},
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ChannelsCustomerPage> {
  const q = (input.q ?? "").trim();
  if (q.length > CUSTOMER_Q_MAX_LEN) {
    throw new StoreApiHttpError(400, "Query is too long.");
  }
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  params.set("limit", String(Math.min(input.limit ?? 50, 50)));
  if (input.offset != null) params.set("offset", String(Math.max(0, input.offset)));
  const url = `${apiBase()}/api/v1/internal/channels/customers/?${params}`;
  const response = await fetchImpl(url, {
    method: "GET",
    headers: serviceHeaders(),
  });
  const body = await parseJson(response);
  if (!response.ok) {
    const errMsg =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `listChannelsCustomers HTTP ${response.status}`;
    throw new StoreApiHttpError(response.status, errMsg, body);
  }
  return unwrapData<ChannelsCustomerPage>(body, response.status);
}

/** Live client — overridable in tests. */
export const storeApiClient: StoreApiClient = new Proxy({} as StoreApiClient, {
  get(_target, prop, receiver) {
    const client = overrideClient ?? createHttpStoreApiClient();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
