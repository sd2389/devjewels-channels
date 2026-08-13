/**
 * Secret reference resolver — never store plaintext tokens in DB or logs.
 *
 * Ref formats:
 * - `env:VAR_NAME` → process.env.VAR_NAME
 * - `sm:SECRET_ID` → local stub `CHANNELS_SM_STUB_<SECRET_ID>` (Secrets Manager later)
 * - `vault:id` → `.data/secrets/<id>.json` (staff UI connect flow; UUID or stable id)
 *
 * Shopify credential JSON (preferred):
 *   {"accessToken":"shpat_…","shopDomain":"store.myshopify.com"}
 */
import { redactSecret } from "./serviceAuth";
import { readVaultSecret } from "./vault";

export class SecretResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretResolveError";
  }
}

export type ShopifyCredentials = {
  accessToken: string;
  shopDomain: string;
  /** App API secret / webhook signing secret when present. */
  webhookSecret?: string;
};

function readEnvValue(name: string): string {
  const value = process.env[name];
  if (value == null || value.trim() === "") {
    throw new SecretResolveError(`Secret env var ${name} is missing or empty`);
  }
  return value;
}

/** Resolve a secret ref to a raw string. Never log the return value. */
export async function resolveSecretString(secretRef: string): Promise<string> {
  const ref = secretRef.trim();
  if (!ref) {
    throw new SecretResolveError("credentials_secret_ref is empty");
  }

  if (ref.startsWith("env:")) {
    return readEnvValue(ref.slice("env:".length));
  }

  if (ref.startsWith("sm:")) {
    const secretId = ref.slice("sm:".length).trim();
    if (!secretId) {
      throw new SecretResolveError("sm: secret id is empty");
    }
    // Local / MVP stub until AWS Secrets Manager is wired.
    const stubKey = `CHANNELS_SM_STUB_${secretId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    return readEnvValue(stubKey);
  }

  if (ref.startsWith("vault:")) {
    const vaultId = ref.slice("vault:".length).trim();
    if (!vaultId) {
      throw new SecretResolveError("vault: secret id is empty");
    }
    try {
      return await readVaultSecret(vaultId);
    } catch (err) {
      throw new SecretResolveError(
        err instanceof Error ? err.message : "Vault secret read failed",
      );
    }
  }

  throw new SecretResolveError(
    `Unsupported secret ref scheme (use env:, sm:, or vault:): ${redactSecret(ref)}`,
  );
}

export async function resolveShopifyCredentials(
  secretRef: string,
  shopDomainFallback?: string | null,
): Promise<ShopifyCredentials> {
  const raw = (await resolveSecretString(secretRef)).trim();

  if (raw.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SecretResolveError("Shopify credential JSON is invalid");
    }
    if (!parsed || typeof parsed !== "object") {
      throw new SecretResolveError("Shopify credential JSON must be an object");
    }
    const obj = parsed as Record<string, unknown>;
    const accessToken =
      typeof obj.accessToken === "string"
        ? obj.accessToken
        : typeof obj.access_token === "string"
          ? obj.access_token
          : "";
    const shopDomain =
      typeof obj.shopDomain === "string"
        ? obj.shopDomain
        : typeof obj.shop_domain === "string"
          ? obj.shop_domain
          : (shopDomainFallback ?? "");
    if (!accessToken.trim()) {
      throw new SecretResolveError("Shopify credential JSON missing accessToken");
    }
    if (!shopDomain.trim()) {
      throw new SecretResolveError("Shopify credential missing shopDomain");
    }
    const webhookSecret =
      typeof obj.webhookSecret === "string"
        ? obj.webhookSecret
        : typeof obj.webhook_secret === "string"
          ? obj.webhook_secret
          : typeof obj.clientSecret === "string"
            ? obj.clientSecret
            : typeof obj.client_secret === "string"
              ? obj.client_secret
              : undefined;
    return {
      accessToken: accessToken.trim(),
      shopDomain: shopDomain.trim(),
      webhookSecret: webhookSecret?.trim() || undefined,
    };
  }

  // Raw token only — shop domain must come from shopify_connection.
  if (!shopDomainFallback?.trim()) {
    throw new SecretResolveError(
      "Raw access token secret requires shop_domain on shopify_connection",
    );
  }
  return { accessToken: raw, shopDomain: shopDomainFallback.trim() };
}
