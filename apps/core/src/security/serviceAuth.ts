/**
 * Service-to-service auth stubs (Django ↔ Channels).
 * MVP: shared bearer token. Later: HMAC / mTLS.
 *
 * Use optionalServerEnv — Next route handlers do not see repo-root `.env`
 * via static `process.env.CHANNELS_SERVICE_TOKEN`.
 */
import { optionalServerEnv } from "../config/serverEnv";

export function getExpectedServiceToken(): string {
  const token = optionalServerEnv("CHANNELS_SERVICE_TOKEN");
  if (!token) {
    throw new Error("CHANNELS_SERVICE_TOKEN is not configured");
  }
  return token;
}

export function extractBearerToken(
  authorization: string | null | undefined,
): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() ?? null;
}

export function assertServiceAuth(authorization: string | null | undefined): void {
  const presented = extractBearerToken(authorization);
  const expected = getExpectedServiceToken();
  if (!presented || presented !== expected) {
    throw new ServiceAuthError("Invalid or missing service credentials");
  }
}

export class ServiceAuthError extends Error {
  readonly status = 401;
  constructor(message: string) {
    super(message);
    this.name = "ServiceAuthError";
  }
}

/** Redact secrets before logging. */
export function redactSecret(value: string | undefined | null): string {
  if (!value) return "";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}
