/**
 * Customer picker client: fragment search unwraps hits; Django failures throw.
 * Run: npm run selfcheck:customers -w @devjewels-channels/core
 */
import { requiredServerEnv } from "../config/serverEnv";
import {
  DeverpHttpError,
  listChannelsCustomers,
} from "./deverp/client";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function main(): Promise<void> {
  process.env.DEVJEWELS_API_BASE_URL = "http://django.test";
  process.env.CHANNELS_SERVICE_TOKEN = "selfcheck-token";
  assert(
    requiredServerEnv("DEVJEWELS_API_BASE_URL") === "http://django.test",
    "process env wins",
  );
  try {
    requiredServerEnv("DJ_CHANNELS_SELFCHECK_MISSING_ENV");
    throw new Error("missing env must throw");
  } catch (err) {
    assert(err instanceof Error && /not configured/.test(err.message), "missing env");
  }

  const page = await listChannelsCustomers({ q: "sms", limit: 50 }, async (url) => {
    const href = String(url);
    assert(href.includes("/api/v1/internal/channels/customers/"), "customers path");
    assert(href.includes("q=sms"), "forwards q");
    return jsonResponse(200, {
      success: true,
      data: {
        items: [
          {
            id: 1632,
            name: "Smit Desai",
            email: "smssmit@gmail.com",
            has_active_api_key: true,
          },
        ],
        limit: 50,
        offset: 0,
        total: 1,
        has_more: false,
      },
    });
  });
  assert(page.items.length === 1, "fragment returns a hit");
  assert(page.items[0]?.id === 1632, "expected customer id");
  assert(page.items[0]?.email === "smssmit@gmail.com", "expected email");

  try {
    await listChannelsCustomers({ q: "sms" }, async () =>
      jsonResponse(403, { success: false, error: "Channels is currently disabled." }),
    );
    throw new Error("API failure must surface");
  } catch (err) {
    assert(err instanceof DeverpHttpError, "DeverpHttpError");
    assert(err.status === 403, "status 403");
    assert(/disabled/i.test(err.message), "safe error message");
  }

  try {
    await listChannelsCustomers({ q: "sms" }, async () =>
      jsonResponse(401, { detail: "Authentication credentials were not provided." }),
    );
    throw new Error("unauthenticated must surface");
  } catch (err) {
    assert(err instanceof DeverpHttpError, "unauth DeverpHttpError");
    assert(err.status === 401, "status 401");
  }

  console.log("deverp.customers.selfcheck ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
