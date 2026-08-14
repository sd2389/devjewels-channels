/**
 * Dashboard / admin API access for staff connect UI.
 * - Bearer CHANNELS_SERVICE_TOKEN always accepted
 * - If CHANNELS_DASHBOARD_PASSWORD is unset, allow same-origin (local staff UX)
 * - If set, require cookie channels_dashboard=1 after POST /api/admin/login
 */
import { DeverpHttpError } from "@/integrations/deverp/client";
import { optionalServerEnv } from "@/config/serverEnv";
import { cookies } from "next/headers";
import {
  assertServiceAuth,
  extractBearerToken,
  ServiceAuthError,
} from "@/security/serviceAuth";

export const DASHBOARD_COOKIE = "channels_dashboard";

export async function assertAdminRequest(req: Request): Promise<void> {
  const auth = req.headers.get("authorization");
  if (extractBearerToken(auth)) {
    assertServiceAuth(auth);
    return;
  }

  const password = optionalServerEnv("CHANNELS_DASHBOARD_PASSWORD");
  if (!password) {
    // Local / pilot: open dashboard APIs without extra login.
    return;
  }

  const jar = await cookies();
  if (jar.get(DASHBOARD_COOKIE)?.value === "1") {
    return;
  }
  throw new ServiceAuthError("Dashboard login required");
}

export function jsonError(err: unknown, fallbackStatus = 500): Response {
  if (err instanceof ServiceAuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof DeverpHttpError) {
    const status = err.status >= 400 && err.status < 600 ? err.status : fallbackStatus;
    const message = status >= 500 ? "Request failed" : err.message;
    return Response.json({ error: message }, { status });
  }
  const message = err instanceof Error ? err.message : "Request failed";
  const status =
    /not found/i.test(message) ? 404 :
    /already connected|required|must look|must be|no locations|inactive|invalid characters|too long/i.test(message) ? 400 :
    fallbackStatus;
  return Response.json({ error: message }, { status });
}
