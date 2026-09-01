/**
 * HMAC-signed Shopify connect invite tokens.
 * Payload: { customer_id, shop, exp, jti } — never log raw tokens.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { optionalProcessEnv } from "@devjewels-channels/core/config/serverEnv";
import { assertMyshopifyDomain } from "./auth";

/** Default invite validity: 7 days. */
export const SHOPIFY_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type ShopifyInvitePayload = {
  customer_id: number;
  shop: string;
  exp: number;
  jti: string;
};

function inviteSigningSecret(): string {
  const dedicated = optionalProcessEnv("CHANNELS_INVITE_SIGNING_SECRET")?.trim();
  if (dedicated) return dedicated;
  const service = optionalProcessEnv("CHANNELS_SERVICE_TOKEN")?.trim();
  if (service) return service;
  throw new Error("Invite signing secret is not configured");
}

function b64urlEncode(data: string | Buffer): string {
  return Buffer.from(data)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(data: string): Buffer {
  const padded = data.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(padLen), "base64");
}

export function createInviteJti(): string {
  return randomUUID();
}

export function signShopifyInviteToken(input: {
  customerId: number;
  shop: string;
  jti: string;
  expiresAt: Date;
}): string {
  const shop = assertMyshopifyDomain(input.shop);
  const cid = Number(input.customerId);
  if (!Number.isInteger(cid) || cid <= 0) {
    throw new Error("customer_id is required");
  }
  const payload: ShopifyInvitePayload = {
    customer_id: cid,
    shop,
    exp: Math.floor(input.expiresAt.getTime() / 1000),
    jti: input.jti,
  };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const sig = createHmac("sha256", inviteSigningSecret())
    .update(payloadB64)
    .digest();
  return `${payloadB64}.${b64urlEncode(sig)}`;
}

export type VerifyShopifyInviteResult =
  | { ok: true; payload: ShopifyInvitePayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyShopifyInviteToken(token: string): VerifyShopifyInviteResult {
  const trimmed = token.trim();
  const dot = trimmed.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };

  const payloadB64 = trimmed.slice(0, dot);
  const sigB64 = trimmed.slice(dot + 1);
  if (!payloadB64 || !sigB64) return { ok: false, reason: "malformed" };

  let expectedSig: Buffer;
  try {
    expectedSig = createHmac("sha256", inviteSigningSecret())
      .update(payloadB64)
      .digest();
  } catch {
    return { ok: false, reason: "malformed" };
  }

  let presentedSig: Buffer;
  try {
    presentedSig = b64urlDecode(sigB64);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (
    expectedSig.length !== presentedSig.length ||
    !timingSafeEqual(expectedSig, presentedSig)
  ) {
    return { ok: false, reason: "bad_signature" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(b64urlDecode(payloadB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "malformed" };
  }
  const obj = parsed as Record<string, unknown>;
  const customerId = Number(obj.customer_id);
  const shop = typeof obj.shop === "string" ? obj.shop : "";
  const exp = Number(obj.exp);
  const jti = typeof obj.jti === "string" ? obj.jti.trim() : "";

  if (
    !Number.isInteger(customerId) ||
    customerId <= 0 ||
    !shop ||
    !Number.isFinite(exp) ||
    exp <= 0 ||
    !jti
  ) {
    return { ok: false, reason: "malformed" };
  }

  if (exp * 1000 <= Date.now()) {
    return { ok: false, reason: "expired" };
  }

  try {
    assertMyshopifyDomain(shop);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  return {
    ok: true,
    payload: {
      customer_id: customerId,
      shop: assertMyshopifyDomain(shop),
      exp,
      jti,
    },
  };
}

export function buildShopifyInviteConnectUrl(baseUrl: string, token: string): string {
  const base = baseUrl.replace(/\/$/, "");
  const url = new URL(`${base}/api/connect/shopify`);
  url.searchParams.set("token", token);
  return url.toString();
}

export function channelsPublicOrigin(): string {
  const explicit = optionalProcessEnv("CHANNELS_PUBLIC_BASE_URL")?.replace(/\/$/, "");
  if (explicit) return explicit;
  return "http://localhost:3100";
}
