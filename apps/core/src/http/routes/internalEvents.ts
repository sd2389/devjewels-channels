import {
  assertServiceAuth,
  ServiceAuthError,
} from "@/security/serviceAuth";
import { claimEventId, releaseEventId } from "@/services/eventIdempotency";
import {
  CATALOG_UPDATED,
  ENTITLEMENT_CHANGED,
  INVENTORY_UPDATED,
  PRICE_UPDATED,
  safeParseEventEnvelope,
} from "@/services/events";
import {
  fanOutCatalogUpdated,
  fanOutPriceUpdated,
} from "@/services/catalogFanOut";
import { fanOutEntitlementChanged } from "@/services/entitlementFanOut";
import { fanOutInventoryUpdated } from "@/services/inventoryFanOut";
import { json } from "../response";

/**
 * Django → Channels event ingest.
 * Auth: Bearer CHANNELS_SERVICE_TOKEN
 */
export async function postInternalEvents(request: Request): Promise<Response> {
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

  const parsed = safeParseEventEnvelope(body);
  if (!parsed.success) {
    return json(
      {
        error: "Invalid event envelope",
        details: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      400,
    );
  }

  const event = parsed.data;
  let claim;
  try {
    claim = await claimEventId(
      event.event_id,
      event.event_type,
      event.occurred_at,
      event,
    );
  } catch (err) {
    console.error("event_idempotency_unavailable", {
      event_id: event.event_id,
      error_type: err instanceof Error ? err.name : "Error",
    });
    return json({ error: "Event persistence unavailable" }, 503);
  }
  if (claim.duplicate) {
    return json(
      {
        accepted: true,
        duplicate: true,
        event_id: event.event_id,
        store: claim.store,
      },
      200,
    );
  }

  if (event.event_type === INVENTORY_UPDATED) {
    try {
      const fanOut = await fanOutInventoryUpdated(event);
      return json(
        {
          accepted: true,
          event_id: event.event_id,
          event_type: event.event_type,
          enqueued: fanOut.enqueued,
          skeleton: fanOut.skeleton,
          transport: fanOut.transport,
          productSyncEnqueued: fanOut.productSyncEnqueued,
        },
        202,
      );
    } catch (err) {
      await releaseEventId(event.event_id);
      console.error("inventory_fan_out_failed", {
        event_id: event.event_id,
        error_type: err instanceof Error ? err.name : "Error",
      });
      return json({ error: "Failed to enqueue inventory sync" }, 500);
    }
  }

  if (event.event_type === CATALOG_UPDATED) {
    try {
      const fanOut = await fanOutCatalogUpdated(event);
      return json(
        {
          accepted: true,
          event_id: event.event_id,
          event_type: event.event_type,
          enqueued: fanOut.enqueued,
          skeleton: fanOut.skeleton,
          transport: fanOut.transport,
        },
        202,
      );
    } catch (err) {
      await releaseEventId(event.event_id);
      console.error("catalog_fan_out_failed", {
        event_id: event.event_id,
        error_type: err instanceof Error ? err.name : "Error",
      });
      return json({ error: "Failed to enqueue product sync" }, 500);
    }
  }

  if (event.event_type === PRICE_UPDATED) {
    try {
      const fanOut = await fanOutPriceUpdated(event);
      return json(
        {
          accepted: true,
          event_id: event.event_id,
          event_type: event.event_type,
          enqueued: fanOut.enqueued,
          skeleton: fanOut.skeleton,
          transport: fanOut.transport,
        },
        202,
      );
    } catch (err) {
      await releaseEventId(event.event_id);
      console.error("price_fan_out_failed", {
        event_id: event.event_id,
        error_type: err instanceof Error ? err.name : "Error",
      });
      return json({ error: "Failed to enqueue product sync for price" }, 500);
    }
  }

  if (event.event_type === ENTITLEMENT_CHANGED) {
    try {
      const fanOut = await fanOutEntitlementChanged(event);
      return json(
        {
          accepted: true,
          event_id: event.event_id,
          event_type: event.event_type,
          enqueued: fanOut.enqueued,
          action: fanOut.action,
        },
        202,
      );
    } catch (err) {
      await releaseEventId(event.event_id);
      console.error("entitlement_fan_out_failed", {
        event_id: event.event_id,
        error_type: err instanceof Error ? err.name : "Error",
      });
      return json({ error: "Failed to enqueue entitlement sync" }, 500);
    }
  }

  return json({ error: "Unsupported event type" }, 400);
}
