/**
 * Shopify OAuth (offline access token) — install URL, CSRF state, code exchange.
 * Never log access tokens.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { optionalProcessEnv } from "@devjewels-channels/core/config/serverEnv";
import {
  tryReadVaultSecret,
  writeVaultSecret,
} from "@devjewels-channels/core/security/vault";
import { getShopifyMetaStore } from "./meta";

/** Stable vault id for Partner app Client ID + Secret (operator one-time save). */
export const SHOPIFY_OAUTH_APP_VAULT_ID = "shopify-oauth-app";

const LOCAL_OAUTH_CALLBACK =
  "http://localhost:3100/api/shopify/auth/callback";

export const SHOPIFY_OAUTH_NOT_CONFIGURED_MESSAGE =
  "Save Partner Client ID and Secret once in the dashboard (Shopify app settings).";

/** Full scope set so merchants are not re-prompted later. */
export const DEFAULT_SHOPIFY_SCOPES = [
  "read_products",
  "write_products",
  "read_inventory",
  "write_inventory",
  "read_locations",
  "read_orders",
].join(",");

const STATE_TTL_MS = 10 * 60 * 1000;

export type ShopifyOAuthConfig = {
  apiKey: string;
  apiSecret: string;
  scopes: string;
  redirectUri: string;
};

export class ShopifyOAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopifyOAuthConfigError";
  }
}

export function normalizeShopifyShopDomain(shop: string): string {
  return shop
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

export function assertMyshopifyDomain(shop: string): string {
  const domain = normalizeShopifyShopDomain(shop);
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(domain)) {
    throw new Error("Shop must be a *.myshopify.com domain");
  }
  return domain;
}

function resolveOAuthRedirectUri(): string {
  const explicit = optionalProcessEnv("SHOPIFY_OAUTH_REDIRECT_URI");
  if (explicit) return explicit;
  const base = optionalProcessEnv("CHANNELS_PUBLIC_BASE_URL");
  if (base) {
    return `${base.replace(/\/$/, "")}/api/shopify/auth/callback`;
  }
  return LOCAL_OAUTH_CALLBACK;
}

async function readVaultOAuthAppCredentials(): Promise<{
  apiKey: string;
  apiSecret: string;
} | null> {
  const raw = await tryReadVaultSecret(SHOPIFY_OAUTH_APP_VAULT_ID);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ShopifyOAuthConfigError(
      "Shopify app credentials in the dashboard are invalid. Save Client ID and Secret again.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ShopifyOAuthConfigError(
      "Shopify app credentials in the dashboard are invalid. Save Client ID and Secret again.",
    );
  }
  const obj = parsed as Record<string, unknown>;
  const apiKey = typeof obj.apiKey === "string" ? obj.apiKey.trim() : "";
  const apiSecret = typeof obj.apiSecret === "string" ? obj.apiSecret.trim() : "";
  if (!apiKey || !apiSecret) return null;
  return { apiKey, apiSecret };
}

/** Vault operator credentials win; env SHOPIFY_API_KEY/SECRET is optional fallback. */
export async function getShopifyOAuthConfig(): Promise<ShopifyOAuthConfig> {
  const fromVault = await readVaultOAuthAppCredentials();
  const apiKey =
    fromVault?.apiKey || optionalProcessEnv("SHOPIFY_API_KEY") || "";
  const apiSecret =
    fromVault?.apiSecret || optionalProcessEnv("SHOPIFY_API_SECRET") || "";
  const scopes =
    optionalProcessEnv("SHOPIFY_SCOPES") || DEFAULT_SHOPIFY_SCOPES;
  const redirectUri = resolveOAuthRedirectUri();

  if (!apiKey || !apiSecret) {
    throw new ShopifyOAuthConfigError(SHOPIFY_OAUTH_NOT_CONFIGURED_MESSAGE);
  }

  return { apiKey, apiSecret, scopes, redirectUri };
}

export type ShopifyOAuthPublicStatus = {
  configured: boolean;
  apiKeyLast4: string | null;
};

/** Dashboard GET shape — never includes apiSecret. */
export async function getShopifyOAuthPublicStatus(): Promise<ShopifyOAuthPublicStatus> {
  try {
    const config = await getShopifyOAuthConfig();
    return { configured: true, apiKeyLast4: config.apiKey.slice(-4) };
  } catch (err) {
    if (err instanceof ShopifyOAuthConfigError) {
      return { configured: false, apiKeyLast4: null };
    }
    throw err;
  }
}

function parseCredentialString(value: unknown, field: string): string {
  if (Array.isArray(value)) {
    throw new Error(`${field} must be a single string`);
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  if (/[\n\r\0]/.test(value)) {
    throw new Error(`${field} contains invalid characters`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} is required`);
  }
  if (trimmed.length > 512) {
    throw new Error(`${field} is too long`);
  }
  return trimmed;
}

export function parseShopifyOAuthAppCredentials(body: unknown): {
  apiKey: string;
  apiSecret: string;
} {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object");
  }
  const obj = body as Record<string, unknown>;
  return {
    apiKey: parseCredentialString(obj.apiKey ?? obj.api_key, "apiKey"),
    apiSecret: parseCredentialString(obj.apiSecret ?? obj.api_secret, "apiSecret"),
  };
}

export async function saveShopifyOAuthAppCredentials(input: {
  apiKey: string;
  apiSecret: string;
}): Promise<ShopifyOAuthPublicStatus> {
  await writeVaultSecret(
    { apiKey: input.apiKey, apiSecret: input.apiSecret },
    SHOPIFY_OAUTH_APP_VAULT_ID,
  );
  return getShopifyOAuthPublicStatus();
}

/** Public base for webhook callback URLs. */
export function channelsPublicBaseUrl(): string {
  const explicit = optionalProcessEnv("CHANNELS_PUBLIC_BASE_URL");
  if (explicit) return explicit.replace(/\/$/, "");
  const redirect = optionalProcessEnv("SHOPIFY_OAUTH_REDIRECT_URI");
  if (redirect) {
    return redirect.replace(/\/api\/shopify\/auth\/callback\/?$/i, "").replace(/\/$/, "");
  }
  throw new ShopifyOAuthConfigError(
    "CHANNELS_PUBLIC_BASE_URL is not set (needed for webhook registration)",
  );
}

export function shopifyWebhookCallbackUrl(): string {
  return `${channelsPublicBaseUrl()}/api/shopify/webhooks`;
}

/**
 * Persist CSRF state and return Shopify authorize URL.
 * customerId is embedded in state so callback can bind the connection.
 */
export async function beginShopifyOAuthInstall(
  shop: string,
  customerId: number,
): Promise<{
  url: string;
  state: string;
  shopDomain: string;
  customerId: number;
}> {
  const config = await getShopifyOAuthConfig();
  const shopDomain = assertMyshopifyDomain(shop);
  const cid = Number(customerId);
  if (!Number.isInteger(cid) || cid <= 0) {
    throw new Error("customer_id is required for Shopify OAuth install");
  }
  const state = `${crypto.randomUUID()}.${cid}`;
  const expiresAt = new Date(Date.now() + STATE_TTL_MS);
  await getShopifyMetaStore().createOAuthState({
    shopDomain,
    state,
    expiresAt,
  });

  const url = new URL(`https://${shopDomain}/admin/oauth/authorize`);
  url.searchParams.set("client_id", config.apiKey);
  url.searchParams.set("scope", config.scopes);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  return { url: url.toString(), state, shopDomain, customerId: cid };
}

export function parseCustomerIdFromOAuthState(state: string): number | null {
  const parts = state.trim().split(".");
  const raw = parts[parts.length - 1];
  const cid = Number(raw);
  if (!Number.isInteger(cid) || cid <= 0) return null;
  return cid;
}

/** @deprecated prefer beginShopifyOAuthInstall (persists state). */
export async function buildShopifyInstallUrl(shop: string): Promise<string> {
  const config = await getShopifyOAuthConfig();
  const shopDomain = assertMyshopifyDomain(shop);
  const state = crypto.randomUUID();
  const url = new URL(`https://${shopDomain}/admin/oauth/authorize`);
  url.searchParams.set("client_id", config.apiKey);
  url.searchParams.set("scope", config.scopes);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export function verifyShopifyOAuthCallbackHmac(
  query: URLSearchParams,
  apiSecret: string,
): boolean {
  const hmac = (query.get("hmac") || "").trim();
  if (!hmac || !apiSecret) return false;

  const entries: string[] = [];
  for (const [key, value] of query.entries()) {
    if (key === "hmac") continue;
    entries.push(`${key}=${value}`);
  }
  entries.sort();
  const message = entries.join("&");
  const digest = createHmac("sha256", apiSecret).update(message).digest("hex");
  try {
    const a = Buffer.from(digest, "utf8");
    const b = Buffer.from(hmac, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export type ShopifyTokenExchangeResult = {
  accessToken: string;
  scope: string;
  shopDomain: string;
};

export async function exchangeShopifyOAuthCode(input: {
  shop: string;
  code: string;
  state: string;
  fetchImpl?: typeof fetch;
}): Promise<ShopifyTokenExchangeResult> {
  const config = await getShopifyOAuthConfig();
  const shopDomain = assertMyshopifyDomain(input.shop);
  const code = input.code.trim();
  if (!code) {
    throw new Error("Missing OAuth code");
  }

  const claimed = await getShopifyMetaStore().consumeOAuthState(input.state.trim());
  if (!claimed) {
    throw new Error("Invalid or expired OAuth state");
  }
  if (claimed.shop_domain !== shopDomain) {
    throw new Error("OAuth state shop mismatch");
  }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const tokenUrl = `https://${shopDomain}/admin/oauth/access_token`;
  let response: Response;
  try {
    response = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: config.apiKey,
        client_secret: config.apiSecret,
        code,
      }),
    });
  } catch {
    throw new Error("Shopify token exchange request failed");
  }

  if (!response.ok) {
    throw new Error(`Shopify token exchange failed (HTTP ${response.status})`);
  }

  const body = (await response.json()) as {
    access_token?: string;
    scope?: string;
  };
  const accessToken = body.access_token?.trim() || "";
  if (!accessToken) {
    throw new Error("Shopify token exchange returned no access_token");
  }

  return {
    accessToken,
    scope: body.scope?.trim() || "",
    shopDomain,
  };
}
