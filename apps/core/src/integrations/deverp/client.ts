/**
 * HTTP client for Django `channels_api` (SoT facades).
 * Channels must never query public tables — only these endpoints.
 */

import { requiredServerEnv } from "../../config/serverEnv";

export type DeverpInventoryJob = {
  design_no: string;
  job_no: string;
  totamt?: string | number;
  [key: string]: unknown;
};

export type DeverpInventory = {
  design_no: string;
  job_no: string | null;
  available_count: number;
  truncated: boolean;
  jobs: DeverpInventoryJob[];
};

export type DeverpPrice = {
  customer_id: number;
  design_no: string;
  job_no?: string | null;
  sku?: string;
  original_price: number;
  final_price: number;
  currency: string;
};

export type DeverpProduct = {
  id: number;
  design_no: string;
  titleline?: string;
  totamt?: string;
  [key: string]: unknown;
};

export type DeverpCatalogPage = {
  items: DeverpProduct[];
  limit: number;
  after_id: number | null;
  next_after_id: number | null;
  has_more: boolean;
  count: number;
  customer_id?: number;
};

export type DeverpEntitlements = {
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

export type DeverpEntitlementCheckResult = {
  design_no: string;
  entitled: Array<{
    customer_id: number;
    permissions: DeverpEntitlements["permissions"];
  }>;
  count: number;
};

export type DeverpReserveOrderPayload = {
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

export type DeverpReserveOrderResult = {
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

export type DeverpClient = {
  listCatalogDesigns(input: {
    customerId: number;
    limit?: number;
    afterId?: number | null;
  }): Promise<DeverpCatalogPage>;
  getProduct(designNo: string, customerId?: number): Promise<DeverpProduct>;
  getInventory(designNo: string, jobNo?: string): Promise<DeverpInventory>;
  getPrice(input: {
    customerId: number;
    designNo: string;
    jobNo?: string;
  }): Promise<DeverpPrice>;
  getEntitlements(customerId: number): Promise<DeverpEntitlements>;
  checkEntitlements(input: {
    designNo: string;
    customerIds: number[];
    requirePermission?: string;
  }): Promise<DeverpEntitlementCheckResult>;
  reserveOrder(payload: DeverpReserveOrderPayload): Promise<DeverpReserveOrderResult>;
};

export class DeverpHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "DeverpHttpError";
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
    throw new DeverpHttpError(status, "Invalid channels_api response");
  }
  const obj = body as { success?: boolean; data?: T; error?: string };
  if (obj.success === false) {
    throw new DeverpHttpError(status, obj.error || "channels_api error", body);
  }
  if (obj.data === undefined) {
    throw new DeverpHttpError(status, "channels_api missing data", body);
  }
  return obj.data;
}

let overrideClient: DeverpClient | null = null;

export function setDeverpClientForTests(client: DeverpClient | null): void {
  overrideClient = client;
}

export function createHttpDeverpClient(
  fetchImpl: typeof fetch = globalThis.fetch,
): DeverpClient {
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
        throw new DeverpHttpError(
          response.status,
          `listCatalogDesigns HTTP ${response.status}`,
          body,
        );
      }
      return unwrapData<DeverpCatalogPage>(body, response.status);
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
        throw new DeverpHttpError(
          response.status,
          `getProduct HTTP ${response.status}`,
          body,
        );
      }
      return unwrapData<DeverpProduct>(body, response.status);
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
        throw new DeverpHttpError(
          response.status,
          `getInventory HTTP ${response.status}`,
          body,
        );
      }
      return unwrapData<DeverpInventory>(body, response.status);
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
        throw new DeverpHttpError(
          response.status,
          `getPrice HTTP ${response.status}`,
          body,
        );
      }
      return unwrapData<DeverpPrice>(body, response.status);
    },

    async getEntitlements(customerId) {
      const url = `${apiBase()}/api/v1/internal/channels/entitlements/?customer_id=${encodeURIComponent(String(customerId))}`;
      const response = await fetchImpl(url, {
        method: "GET",
        headers: serviceHeaders(),
      });
      const body = await parseJson(response);
      if (!response.ok) {
        throw new DeverpHttpError(
          response.status,
          `getEntitlements HTTP ${response.status}`,
          body,
        );
      }
      return unwrapData<DeverpEntitlements>(body, response.status);
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
        throw new DeverpHttpError(
          response.status,
          `checkEntitlements HTTP ${response.status}`,
          body,
        );
      }
      return unwrapData<DeverpEntitlementCheckResult>(body, response.status);
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
        throw new DeverpHttpError(response.status, errMsg, body);
      }
      return unwrapData<DeverpReserveOrderResult>(body, response.status);
    },
  };
}

export async function listChannelsCustomers(
  input: { q?: string; limit?: number; offset?: number } = {},
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ChannelsCustomerPage> {
  const q = (input.q ?? "").trim();
  if (q.length > CUSTOMER_Q_MAX_LEN) {
    throw new DeverpHttpError(400, "Query is too long.");
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
    throw new DeverpHttpError(response.status, errMsg, body);
  }
  return unwrapData<ChannelsCustomerPage>(body, response.status);
}

/** Live client — overridable in tests. */
export const deverpClient: DeverpClient = new Proxy({} as DeverpClient, {
  get(_target, prop, receiver) {
    const client = overrideClient ?? createHttpDeverpClient();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
