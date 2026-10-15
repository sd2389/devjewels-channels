import {
  assertServiceAuth,
  ServiceAuthError,
} from "@/security/serviceAuth";
import { applyCustomerDesignMarkupsAndSync } from "@/services/customerMarkupSync";
import { json } from "../response";

/**
 * Django → Channels: apply customer design markups and enqueue product.sync.
 * Auth: Bearer CHANNELS_SERVICE_TOKEN
 *
 * POST /api/internal/customer-markup
 * {
 *   "customer_id": 42,
 *   "design_markups": [
 *     { "designNo": "DE-435", "markupMode": "percent", "markupValue": 15 }
 *   ],
 *   "sync": true
 * }
 */
export async function postInternalCustomerMarkup(
  request: Request,
): Promise<Response> {
  try {
    assertServiceAuth(request.headers.get("authorization"));
  } catch (err) {
    if (err instanceof ServiceAuthError) {
      return json({ error: "Unauthorized" }, 401);
    }
    return json({ error: "Service auth misconfigured" }, 500);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Body must be a JSON object" }, 400);
  }

  const payload = body as Record<string, unknown>;
  try {
    const result = await applyCustomerDesignMarkupsAndSync({
      customerId: Number(payload.customer_id ?? payload.customerId),
      designMarkups: payload.design_markups ?? payload.designMarkups,
      sync: payload.sync !== false && payload.sync !== "false",
    });
    return json({ success: true, data: result }, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request";
    const isValidation =
      /must be|required|Invalid|Duplicate|At most|empty/i.test(message);
    console.error("customer_markup_apply_failed", {
      error_type: err instanceof Error ? err.name : "Error",
      message: isValidation ? message : "apply_failed",
    });
    return json(
      { error: isValidation ? message : "Failed to apply markup" },
      isValidation ? 400 : 500,
    );
  }
}
