/**
 * Shopify OAuth + webhook registration selfcheck (mocked HTTP / memory stores).
 * Run: npm run selfcheck:oauth -w @devjewels-channels/shopify
 */
import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  beginShopifyOAuthInstall,
  exchangeShopifyOAuthCode,
  getShopifyOAuthConfig,
  getShopifyOAuthPublicStatus,
  parseShopifyOAuthAppCredentials,
  saveShopifyOAuthAppCredentials,
  ShopifyOAuthConfigError,
  SHOPIFY_OAUTH_NOT_CONFIGURED_MESSAGE,
  verifyShopifyOAuthCallbackHmac,
  DEFAULT_SHOPIFY_SCOPES,
} from "./auth";
import {
  createMemoryShopifyMetaStore,
  setShopifyMetaStoreForTests,
} from "./meta";
import {
  registerShopifyWebhooks,
  SHOPIFY_ORDER_WEBHOOK_TOPICS,
} from "./webhooks";

function setOauthEnv(): void {
  process.env.SHOPIFY_API_KEY = "key_test";
  process.env.SHOPIFY_API_SECRET = "secret_test";
  process.env.SHOPIFY_SCOPES = DEFAULT_SHOPIFY_SCOPES;
  process.env.SHOPIFY_OAUTH_REDIRECT_URI =
    "http://localhost:3100/api/shopify/auth/callback";
  process.env.CHANNELS_PUBLIC_BASE_URL = "https://channels.example.com";
}

async function main(): Promise<void> {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "channels-oauth-selfcheck-"));
  process.env.CHANNELS_VAULT_DIR = vaultDir;
  setOauthEnv();
  const meta = createMemoryShopifyMetaStore();
  setShopifyMetaStoreForTests(meta);

  // Config present (env fallback)
  const config = await getShopifyOAuthConfig();
  if (config.apiKey !== "key_test") throw new Error("config apiKey mismatch");
  if (
    config.redirectUri !== "http://localhost:3100/api/shopify/auth/callback"
  ) {
    throw new Error("config redirectUri mismatch");
  }

  // CHANNELS_PUBLIC_BASE_URL alone derives redirect URI
  const savedRedirect = process.env.SHOPIFY_OAUTH_REDIRECT_URI;
  delete process.env.SHOPIFY_OAUTH_REDIRECT_URI;
  process.env.CHANNELS_PUBLIC_BASE_URL = "http://localhost:3100/";
  const derived = await getShopifyOAuthConfig();
  if (
    derived.redirectUri !==
    "http://localhost:3100/api/shopify/auth/callback"
  ) {
    throw new Error("expected redirect from CHANNELS_PUBLIC_BASE_URL");
  }

  // No redirect env → local default
  delete process.env.CHANNELS_PUBLIC_BASE_URL;
  const localDefault = await getShopifyOAuthConfig();
  if (localDefault.redirectUri !== "http://localhost:3100/api/shopify/auth/callback") {
    throw new Error("expected localhost:3100 redirect default");
  }
  process.env.SHOPIFY_OAUTH_REDIRECT_URI = savedRedirect;
  process.env.CHANNELS_PUBLIC_BASE_URL = "https://channels.example.com";

  // Missing vault+env fails with dashboard message (not .env)
  const savedKey = process.env.SHOPIFY_API_KEY;
  const savedSecret = process.env.SHOPIFY_API_SECRET;
  delete process.env.SHOPIFY_API_KEY;
  delete process.env.SHOPIFY_API_SECRET;
  let missingCaught = false;
  let missingMessage = "";
  try {
    await getShopifyOAuthConfig();
  } catch (err) {
    missingCaught = err instanceof ShopifyOAuthConfigError;
    missingMessage = err instanceof Error ? err.message : "";
  }
  if (!missingCaught) throw new Error("expected ShopifyOAuthConfigError");
  if (missingMessage !== SHOPIFY_OAUTH_NOT_CONFIGURED_MESSAGE) {
    throw new Error(`unexpected missing-config message: ${missingMessage}`);
  }
  if (/\.env\b/i.test(missingMessage)) {
    throw new Error("missing-config message must not tell the user to edit .env");
  }

  // GET public status never leaks secret
  const emptyStatus = await getShopifyOAuthPublicStatus();
  if (emptyStatus.configured) throw new Error("expected unconfigured public status");
  const emptyDump = JSON.stringify(emptyStatus);
  if (/secret_test|apiSecret|api_secret/i.test(emptyDump)) {
    throw new Error("public status leaked secret while unconfigured");
  }

  // Vault operator credentials win over env; public status hides secret
  const saved = await saveShopifyOAuthAppCredentials({
    apiKey: "vault_key_abcd",
    apiSecret: "vault_secret_never_return",
  });
  if (!saved.configured || saved.apiKeyLast4 !== "abcd") {
    throw new Error("expected vault save public status last4");
  }
  process.env.SHOPIFY_API_KEY = "env_key_should_lose";
  process.env.SHOPIFY_API_SECRET = "env_secret_should_lose";
  const fromVault = await getShopifyOAuthConfig();
  if (fromVault.apiKey !== "vault_key_abcd") {
    throw new Error("vault credentials must win over env");
  }
  if (fromVault.apiSecret !== "vault_secret_never_return") {
    throw new Error("vault secret mismatch");
  }
  const publicStatus = await getShopifyOAuthPublicStatus();
  const publicDump = JSON.stringify(publicStatus);
  if (!publicStatus.configured) throw new Error("expected configured public status");
  if (publicDump.includes("vault_secret_never_return") || /apiSecret/i.test(publicDump)) {
    throw new Error("GET config must never leak apiSecret");
  }
  if (publicStatus.apiKeyLast4 !== "abcd") {
    throw new Error("expected apiKeyLast4");
  }

  // Denied: array / injection junk rejected
  let arrayRejected = false;
  try {
    parseShopifyOAuthAppCredentials({
      apiKey: ["victim", "attacker"],
      apiSecret: "x",
    });
  } catch (err) {
    arrayRejected =
      err instanceof Error && /must be a single string/i.test(err.message);
  }
  if (!arrayRejected) throw new Error("expected array apiKey reject");
  let crlfRejected = false;
  try {
    parseShopifyOAuthAppCredentials({
      apiKey: "ok",
      apiSecret: "line1\nBcc:evil",
    });
  } catch (err) {
    crlfRejected =
      err instanceof Error && /invalid characters/i.test(err.message);
  }
  if (!crlfRejected) throw new Error("expected CRLF apiSecret reject");

  process.env.SHOPIFY_API_KEY = savedKey;
  process.env.SHOPIFY_API_SECRET = savedSecret;
  await fs.rm(vaultDir, { recursive: true, force: true });
  const emptyVault = await fs.mkdtemp(path.join(os.tmpdir(), "channels-oauth-selfcheck-"));
  process.env.CHANNELS_VAULT_DIR = emptyVault;

  // Denied: customer_id required
  let missingCustomer = false;
  try {
    await beginShopifyOAuthInstall("Demo-Shop.myshopify.com", 0 as unknown as number);
  } catch (err) {
    missingCustomer =
      err instanceof Error && /customer_id is required/i.test(err.message);
  }
  if (!missingCustomer) {
    throw new Error("expected customer_id required reject");
  }

  // Begin install persists state + embeds customer_id in OAuth state
  const started = await beginShopifyOAuthInstall("Demo-Shop.myshopify.com", 42);
  if (started.customerId !== 42) {
    throw new Error("install must return customerId");
  }
  if (!started.state.endsWith(".42")) {
    throw new Error("oauth state must embed customer_id");
  }
  if (!started.url.includes("Demo-Shop.myshopify.com".toLowerCase())) {
    throw new Error("install URL missing shop");
  }
  if (!started.url.includes("client_id=key_test")) {
    throw new Error("install URL missing client_id");
  }
  if (!started.url.includes(encodeURIComponent(DEFAULT_SHOPIFY_SCOPES))) {
    // scopes may be comma-joined unencoded in query — check raw
    if (!started.url.includes("read_orders")) {
      throw new Error("install URL missing scopes");
    }
  }

  // Bad state rejected
  let badState = false;
  try {
    await exchangeShopifyOAuthCode({
      shop: "demo-shop.myshopify.com",
      code: "code1",
      state: "not-a-real-state",
      fetchImpl: (async () => new Response("{}")) as typeof fetch,
    });
  } catch (err) {
    badState =
      err instanceof Error && /invalid or expired oauth state/i.test(err.message);
  }
  if (!badState) throw new Error("expected state reject");

  // Callback HMAC
  const params = new URLSearchParams({
    code: "abc",
    shop: "demo-shop.myshopify.com",
    state: started.state,
    timestamp: "123",
  });
  const entries = [...params.entries()]
    .filter(([k]) => k !== "hmac")
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("&");
  const hmac = createHmac("sha256", "secret_test").update(entries).digest("hex");
  params.set("hmac", hmac);
  if (!verifyShopifyOAuthCallbackHmac(params, "secret_test")) {
    throw new Error("expected valid OAuth HMAC");
  }
  params.set("hmac", "deadbeef");
  if (verifyShopifyOAuthCallbackHmac(params, "secret_test")) {
    throw new Error("expected invalid OAuth HMAC");
  }

  // Successful token exchange (mocked)
  const tokenCalls: string[] = [];
  const token = await exchangeShopifyOAuthCode({
    shop: "demo-shop.myshopify.com",
    code: "oauth_code",
    state: started.state,
    fetchImpl: (async (url, init) => {
      tokenCalls.push(String(url));
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("oauth_code") && body.includes("secret_test")) {
        return new Response(
          JSON.stringify({ access_token: "shpat_offline", scope: DEFAULT_SHOPIFY_SCOPES }),
          { status: 200 },
        );
      }
      return new Response("bad", { status: 400 });
    }) as typeof fetch,
  });
  if (token.accessToken !== "shpat_offline") {
    throw new Error("token exchange accessToken mismatch");
  }
  if (tokenCalls.length !== 1) throw new Error("expected one token exchange call");

  // State is one-time (already consumed)
  let reused = false;
  try {
    await exchangeShopifyOAuthCode({
      shop: "demo-shop.myshopify.com",
      code: "again",
      state: started.state,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ access_token: "x" }))) as typeof fetch,
    });
  } catch (err) {
    reused =
      err instanceof Error && /invalid or expired oauth state/i.test(err.message);
  }
  if (!reused) throw new Error("expected consumed state reject");

  // Webhook register called + persisted
  const webhookCalls: Array<{ method: string; url: string; body?: string }> = [];
  await meta.upsertShop("conn-1", "demo-shop.myshopify.com");
  const registered = await registerShopifyWebhooks({
    shopDomain: "demo-shop.myshopify.com",
    accessToken: "shpat_offline",
    callbackUrl: "https://channels.example.com/api/shopify/webhooks",
    connectionId: "conn-1",
    fetchImpl: (async (url, init) => {
      const method = (init?.method || "GET").toUpperCase();
      const body = typeof init?.body === "string" ? init.body : undefined;
      webhookCalls.push({ method, url: String(url), body });
      if (method === "GET") {
        return new Response(JSON.stringify({ webhooks: [] }), { status: 200 });
      }
      const parsed = body ? (JSON.parse(body) as { webhook?: { topic?: string } }) : {};
      const topic = parsed.webhook?.topic || "unknown";
      return new Response(
        JSON.stringify({ webhook: { id: `wh_${topic.replace("/", "_")}` } }),
        { status: 201 },
      );
    }) as typeof fetch,
  });
  if (registered.length !== SHOPIFY_ORDER_WEBHOOK_TOPICS.length) {
    throw new Error(`expected ${SHOPIFY_ORDER_WEBHOOK_TOPICS.length} webhooks`);
  }
  if (!registered.every((r) => r.created)) {
    throw new Error("expected all webhooks created");
  }
  const stored = await meta.listWebhookSubscriptions("conn-1");
  if (stored.length !== SHOPIFY_ORDER_WEBHOOK_TOPICS.length) {
    throw new Error("webhook subscriptions not persisted");
  }
  if (webhookCalls.filter((c) => c.method === "POST").length !== 3) {
    throw new Error("expected 3 webhook create POSTs");
  }

  // Idempotent re-register (existing address) does not POST again
  const again = await registerShopifyWebhooks({
    shopDomain: "demo-shop.myshopify.com",
    accessToken: "shpat_offline",
    callbackUrl: "https://channels.example.com/api/shopify/webhooks",
    connectionId: "conn-1",
    fetchImpl: (async (url, init) => {
      const method = (init?.method || "GET").toUpperCase();
      if (method === "GET") {
        return new Response(
          JSON.stringify({
            webhooks: SHOPIFY_ORDER_WEBHOOK_TOPICS.map((topic) => ({
              id: `wh_${topic.replace("/", "_")}`,
              topic,
              address: "https://channels.example.com/api/shopify/webhooks",
            })),
          }),
          { status: 200 },
        );
      }
      throw new Error("unexpected create when webhooks already exist");
    }) as typeof fetch,
  });
  if (!again.every((r) => !r.created)) {
    throw new Error("expected reuse of existing webhooks");
  }

  setShopifyMetaStoreForTests(null);
  await fs.rm(emptyVault, { recursive: true, force: true });
  console.log("shopify oauth.selfcheck ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
