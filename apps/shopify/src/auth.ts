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

/**
 * Secondary vault for the Public App Store app while Custom BuffedBubbly
 * remains primary. App Store install HMAC is signed with this secret.
 */
export const SHOPIFY_OAUTH_APP_PUBLIC_VAULT_ID = "shopify-oauth-app-public";

/** DevJewels-Channels Public distribution Client ID (App Store). */
export const DEVJEWELS_CHANNELS_PUBLIC_CLIENT_ID =
  "4238185738d48848640cb7bf46362437";

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
  /** When set, App Store installs without a pending invite bind to this customer. */
  appStoreFallbackCustomerId?: number;
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

type VaultOAuthPayload = {
  apiKey: string;
  apiSecret: string;
  appStoreFallbackCustomerId?: number;
};

function parseVaultOAuthPayload(
  raw: string,
  invalidMessage: string,
): VaultOAuthPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ShopifyOAuthConfigError(invalidMessage);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ShopifyOAuthConfigError(invalidMessage);
  }
  const obj = parsed as Record<string, unknown>;
  const apiKey = typeof obj.apiKey === "string" ? obj.apiKey.trim() : "";
  const apiSecret = typeof obj.apiSecret === "string" ? obj.apiSecret.trim() : "";
  if (!apiKey || !apiSecret) return null;
  const fallbackRaw = obj.appStoreFallbackCustomerId ?? obj.fallbackCustomerId;
  const fallbackCid = Number(fallbackRaw);
  return {
    apiKey,
    apiSecret,
    ...(Number.isInteger(fallbackCid) && fallbackCid > 0
      ? { appStoreFallbackCustomerId: fallbackCid }
      : {}),
  };
}

async function readVaultOAuthAppCredentials(): Promise<VaultOAuthPayload | null> {
  const raw = await tryReadVaultSecret(SHOPIFY_OAUTH_APP_VAULT_ID);
  if (!raw) return null;
  return parseVaultOAuthPayload(
    raw,
    "Shopify app credentials in the dashboard are invalid. Save Client ID and Secret again.",
  );
}

async function readPublicVaultOAuthAppCredentials(): Promise<VaultOAuthPayload | null> {
  const raw = await tryReadVaultSecret(SHOPIFY_OAUTH_APP_PUBLIC_VAULT_ID);
  if (!raw) return null;
  return parseVaultOAuthPayload(
    raw,
    "Public Shopify app credentials in the vault are invalid. Re-save Client ID and Secret.",
  );
}

function envFallbackCustomerId(): number | undefined {
  const raw =
    optionalProcessEnv("SHOPIFY_APP_STORE_FALLBACK_CUSTOMER_ID") || "";
  const cid = Number(raw);
  if (!Number.isInteger(cid) || cid <= 0) return undefined;
  return cid;
}

/**
 * Primary (Custom/BuffedBubbly) plus optional Public App Store credentials.
 * Dedupes by apiKey. Order: vault primary, public vault, env primary, env public.
 */
export async function listShopifyOAuthConfigs(): Promise<ShopifyOAuthConfig[]> {
  const scopes =
    optionalProcessEnv("SHOPIFY_SCOPES") || DEFAULT_SHOPIFY_SCOPES;
  const redirectUri = resolveOAuthRedirectUri();
  const envFallback = envFallbackCustomerId();
  const out: ShopifyOAuthConfig[] = [];
  const seenKeys = new Set<string>();

  const add = (payload: {
    apiKey: string;
    apiSecret: string;
    appStoreFallbackCustomerId?: number;
  }) => {
    const apiKey = payload.apiKey.trim();
    const apiSecret = payload.apiSecret.trim();
    if (!apiKey || !apiSecret || seenKeys.has(apiKey)) return;
    seenKeys.add(apiKey);
    const fallback =
      payload.appStoreFallbackCustomerId ??
      (apiKey === DEVJEWELS_CHANNELS_PUBLIC_CLIENT_ID ? envFallback : undefined);
    out.push({
      apiKey,
      apiSecret,
      scopes,
      redirectUri,
      ...(fallback ? { appStoreFallbackCustomerId: fallback } : {}),
    });
  };

  const primaryVault = await readVaultOAuthAppCredentials();
  if (primaryVault) add(primaryVault);

  const publicVault = await readPublicVaultOAuthAppCredentials();
  if (publicVault) add(publicVault);

  const envKey = optionalProcessEnv("SHOPIFY_API_KEY") || "";
  const envSecret = optionalProcessEnv("SHOPIFY_API_SECRET") || "";
  if (envKey && envSecret) add({ apiKey: envKey, apiSecret: envSecret });

  const pubKey =
    optionalProcessEnv("SHOPIFY_PUBLIC_API_KEY") ||
    DEVJEWELS_CHANNELS_PUBLIC_CLIENT_ID;
  const pubSecret = optionalProcessEnv("SHOPIFY_PUBLIC_API_SECRET") || "";
  if (pubKey && pubSecret) {
    add({
      apiKey: pubKey,
      apiSecret: pubSecret,
      appStoreFallbackCustomerId: envFallback,
    });
  }

  if (!out.length) {
    throw new ShopifyOAuthConfigError(SHOPIFY_OAUTH_NOT_CONFIGURED_MESSAGE);
  }
  return out;
}

/** Vault operator credentials win; env SHOPIFY_API_KEY/SECRET is optional fallback. */
export async function getShopifyOAuthConfig(): Promise<ShopifyOAuthConfig> {
  return (await listShopifyOAuthConfigs())[0]!;
}

export async function getShopifyOAuthConfigByClientId(
  clientId: string,
): Promise<ShopifyOAuthConfig | null> {
  const needle = clientId.trim();
  if (!needle) return null;
  const configs = await listShopifyOAuthConfigs();
  return configs.find((c) => c.apiKey === needle) ?? null;
}

export async function matchShopifyOAuthConfigByHmac(
  query: URLSearchParams,
): Promise<ShopifyOAuthConfig | null> {
  const configs = await listShopifyOAuthConfigs();
  for (const config of configs) {
    if (verifyShopifyOAuthCallbackHmac(query, config.apiSecret)) {
      return config;
    }
  }
  return null;
}

export async function saveShopifyPublicOAuthAppCredentials(input: {
  apiKey: string;
  apiSecret: string;
  appStoreFallbackCustomerId?: number;
}): Promise<ShopifyOAuthPublicStatus> {
  const payload: Record<string, unknown> = {
    apiKey: input.apiKey,
    apiSecret: input.apiSecret,
  };
  if (
    input.appStoreFallbackCustomerId != null &&
    Number.isInteger(input.appStoreFallbackCustomerId) &&
    input.appStoreFallbackCustomerId > 0
  ) {
    payload.appStoreFallbackCustomerId = input.appStoreFallbackCustomerId;
  }
  await writeVaultSecret(payload, SHOPIFY_OAUTH_APP_PUBLIC_VAULT_ID);
  console.info("shopify_oauth_public_app_saved", {
    apiKeyLast4: input.apiKey.slice(-4),
  });
  return getShopifyOAuthPublicStatus();
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
  const status = await getShopifyOAuthPublicStatus();
  console.info("shopify_oauth_app_saved", {
    apiKeyLast4: status.apiKeyLast4,
  });
  return status;
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
 * When merchantSuccess is true, state suffix `.m` routes callback to /connect/success.
 */
export async function beginShopifyOAuthInstall(
  shop: string,
  customerId: number,
  options: {
    merchantSuccess?: boolean;
    config?: ShopifyOAuthConfig;
    clientId?: string;
  } = {},
): Promise<{
  url: string;
  state: string;
  shopDomain: string;
  customerId: number;
  merchantSuccess: boolean;
  apiKey: string;
}> {
  let config = options.config ?? null;
  if (!config && options.clientId) {
    config = await getShopifyOAuthConfigByClientId(options.clientId);
  }
  if (!config) {
    config = await getShopifyOAuthConfig();
  }
  const shopDomain = assertMyshopifyDomain(shop);
  const cid = Number(customerId);
  if (!Number.isInteger(cid) || cid <= 0) {
    throw new Error("customer_id is required for Shopify OAuth install");
  }
  const merchantSuccess = options.merchantSuccess === true;
  const state = `${crypto.randomUUID()}.${cid}${merchantSuccess ? ".m" : ""}`;
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
  return {
    url: url.toString(),
    state,
    shopDomain,
    customerId: cid,
    merchantSuccess,
    apiKey: config.apiKey,
  };
}

export function parseCustomerIdFromOAuthState(state: string): number | null {
  const trimmed = state.trim();
  const withoutMerchant = trimmed.endsWith(".m")
    ? trimmed.slice(0, -2)
    : trimmed;
  const parts = withoutMerchant.split(".");
  const raw = parts[parts.length - 1];
  const cid = Number(raw);
  if (!Number.isInteger(cid) || cid <= 0) return null;
  return cid;
}

export function isMerchantOAuthState(state: string): boolean {
  return state.trim().endsWith(".m");
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
  config?: ShopifyOAuthConfig;
}): Promise<ShopifyTokenExchangeResult> {
  const config = input.config ?? (await getShopifyOAuthConfig());
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
