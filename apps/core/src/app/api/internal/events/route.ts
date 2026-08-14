import { NextRequest, NextResponse } from "next/server";
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

/**
 * Django → Channels event ingest (MVP HTTP).
 * Auth: Bearer CHANNELS_SERVICE_TOKEN
 * Idempotent by event_id (channels.ingest_event on shared Postgres, else memory).
 */
export async function POST(request: NextRequest) {
  try {
    assertServiceAuth(request.headers.get("authorization"));
  } catch (err) {
    if (err instanceof ServiceAuthError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Service auth misconfigured" }, { status: 500 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = safeParseEventEnvelope(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid event envelope",
        details: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
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
    return NextResponse.json(
      { error: "Event persistence unavailable" },
      { status: 503 },
    );
  }
  if (claim.duplicate) {
    return NextResponse.json(
      {
        accepted: true,
        duplicate: true,
        event_id: event.event_id,
        store: claim.store,
      },
      { status: 200 },
    );
  }

  if (event.event_type === INVENTORY_UPDATED) {
    try {
      const fanOut = await fanOutInventoryUpdated(event);
      return NextResponse.json(
        {
          accepted: true,
          event_id: event.event_id,
          event_type: event.event_type,
          enqueued: fanOut.enqueued,
          skeleton: fanOut.skeleton,
          transport: fanOut.transport,
          productSyncEnqueued: fanOut.productSyncEnqueued,
        },
        { status: 202 },
      );
    } catch (err) {
      await releaseEventId(event.event_id);
      console.error("inventory_fan_out_failed", {
        event_id: event.event_id,
        error_type: err instanceof Error ? err.name : "Error",
      });
      return NextResponse.json(
        { error: "Failed to enqueue inventory sync" },
        { status: 500 },
      );
    }
  }

  if (event.event_type === CATALOG_UPDATED) {
    try {
      const fanOut = await fanOutCatalogUpdated(event);
      return NextResponse.json(
        {
          accepted: true,
          event_id: event.event_id,
          event_type: event.event_type,
          enqueued: fanOut.enqueued,
          skeleton: fanOut.skeleton,
          transport: fanOut.transport,
        },
        { status: 202 },
      );
    } catch (err) {
      await releaseEventId(event.event_id);
      console.error("catalog_fan_out_failed", {
        event_id: event.event_id,
        error_type: err instanceof Error ? err.name : "Error",
      });
      return NextResponse.json(
        { error: "Failed to enqueue product sync" },
        { status: 500 },
      );
    }
  }

  if (event.event_type === PRICE_UPDATED) {
    try {
      const fanOut = await fanOutPriceUpdated(event);
      return NextResponse.json(
        {
          accepted: true,
          event_id: event.event_id,
          event_type: event.event_type,
          enqueued: fanOut.enqueued,
          skeleton: fanOut.skeleton,
          transport: fanOut.transport,
        },
        { status: 202 },
      );
    } catch (err) {
      await releaseEventId(event.event_id);
      console.error("price_fan_out_failed", {
        event_id: event.event_id,
        error_type: err instanceof Error ? err.name : "Error",
      });
      return NextResponse.json(
        { error: "Failed to enqueue product sync for price" },
        { status: 500 },
      );
    }
  }

  if (event.event_type === ENTITLEMENT_CHANGED) {
    try {
      const fanOut = await fanOutEntitlementChanged(event);
      return NextResponse.json(
        {
          accepted: true,
          event_id: event.event_id,
          event_type: event.event_type,
          enqueued: fanOut.enqueued,
          action: fanOut.action,
        },
        { status: 202 },
      );
    } catch (err) {
      await releaseEventId(event.event_id);
      console.error("entitlement_fan_out_failed", {
        event_id: event.event_id,
        error_type: err instanceof Error ? err.name : "Error",
      });
      return NextResponse.json(
        { error: "Failed to enqueue entitlement sync" },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ error: "Unsupported event type" }, { status: 400 });
}
