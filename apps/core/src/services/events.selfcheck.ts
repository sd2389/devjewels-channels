/**
 * Smoke: zod envelope contract (Django ↔ Channels), auth denial, fan-out skeleton.
 * Run: npm run selfcheck:events -w @devjewels-channels/core
 */
import {
  assertServiceAuth,
  ServiceAuthError,
} from "../security/serviceAuth";
import { resetMemoryIdempotencyStore, claimEventId } from "./eventIdempotency";
import {
  ENTITLEMENT_CHANGED,
  parseEventEnvelope,
  safeParseEventEnvelope,
} from "./events";
import { fanOutInventoryUpdated } from "./inventoryFanOut";
import { fanOutCatalogUpdated } from "./catalogFanOut";
import {
  createMemoryConnectionStore,
  setConnectionStoreForTests,
} from "./connections";
import {
  drainMemoryInventoryQueue,
  drainMemoryProductQueue,
} from "./queue";
import { handleInventorySync, handleProductSync } from "../workers/handlers";

const SERVICE_TOKEN = "selfcheck-token";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function expectAuthDenied(authorization: string | null | undefined, label: string): void {
  try {
    assertServiceAuth(authorization);
    throw new Error(`${label}: expected ServiceAuthError`);
  } catch (err) {
    if (!(err instanceof ServiceAuthError)) throw err;
  }
}

async function main(): Promise<void> {
  process.env.CHANNELS_SERVICE_TOKEN = SERVICE_TOKEN;
  delete process.env.INVENTORY_SYNC_QUEUE_URL;
  delete process.env.PRODUCT_SYNC_QUEUE_URL;
  process.env.CHANNELS_ENQUEUE_SKELETON_ON_UNMAPPED = "1";
  // Force memory idempotency for selfcheck (no DB required).
  delete process.env.DATABASE_URL;
  // Fan-out requires a connection store; empty memory → skeleton enqueue path.
  setConnectionStoreForTests(createMemoryConnectionStore([]));

  // --- Auth contract: Bearer CHANNELS_SERVICE_TOKEN only (Django publish header) ---
  assertServiceAuth(`Bearer ${SERVICE_TOKEN}`);
  expectAuthDenied(null, "missing Authorization");
  expectAuthDenied("Bearer wrong-token", "wrong Bearer");
  expectAuthDenied(`Bearer ${SERVICE_TOKEN}x`, "near-miss Bearer");
  // Customer X-API-Key alone must never authenticate ingest.
  expectAuthDenied(undefined, "undefined Authorization (X-API-Key-only callers)");

  resetMemoryIdempotencyStore();
  drainMemoryInventoryQueue();
  drainMemoryProductQueue();

  const envelope = parseEventEnvelope({
    event_id: "selfcheck-evt-1",
    event_type: "inventory.updated",
    occurred_at: "2026-08-12T17:00:00.000Z",
    data: {
      design_no: "SC-1",
      job_no: "JOB-1",
      old_quantity: 1,
      new_quantity: 0,
    },
  });

  const first = await claimEventId(
    envelope.event_id,
    envelope.event_type,
    envelope.occurred_at,
    envelope,
  );
  if (first.duplicate) throw new Error("first claim should not be duplicate");

  const second = await claimEventId(
    envelope.event_id,
    envelope.event_type,
    envelope.occurred_at,
    envelope,
  );
  if (!second.duplicate) throw new Error("second claim should be duplicate");

  // Unmapped inventory → product.sync skeleton (auto-create path).
  const fanOut = await fanOutInventoryUpdated(envelope);
  if ((fanOut.productSyncEnqueued ?? 0) < 1 || !fanOut.skeleton) {
    throw new Error(
      `expected product sync skeleton, got ${JSON.stringify(fanOut)}`,
    );
  }

  const productJobs = drainMemoryProductQueue();
  if (productJobs.length !== 1) {
    throw new Error(`expected 1 product job, got ${productJobs.length}`);
  }
  await handleProductSync(productJobs[0]!);

  // catalog.updated → product.sync
  const catalogEnvelope = parseEventEnvelope({
    event_id: "selfcheck-catalog-1",
    event_type: "catalog.updated",
    occurred_at: "2026-08-12T17:01:00.000Z",
    data: {
      design_no: "SC-2",
      change_type: "updated",
      reason: "design_save",
    },
  });
  const catalogFanOut = await fanOutCatalogUpdated(catalogEnvelope);
  if (catalogFanOut.enqueued !== 1 || !catalogFanOut.skeleton) {
    throw new Error(
      `expected catalog skeleton enqueue, got ${JSON.stringify(catalogFanOut)}`,
    );
  }
  const catalogJobs = drainMemoryProductQueue();
  if (catalogJobs.length !== 1) {
    throw new Error(`expected 1 catalog job, got ${catalogJobs.length}`);
  }
  await handleProductSync(catalogJobs[0]!);

  // --- Entitlement envelope shapes (Django ↔ Channels contract) ---
  const entitlementActions = [
    "grant",
    "revoke",
    "key_revoked",
    "permissions_changed",
  ] as const;
  for (const action of entitlementActions) {
    const designNos = action === "grant" || action === "revoke" ? ["D-1"] : [];
    const parsed = parseEventEnvelope({
      event_id: `selfcheck-ent-${action}`,
      event_type: ENTITLEMENT_CHANGED,
      occurred_at: "2026-08-12T17:02:00.000Z",
      data: {
        customer_id: 42,
        action,
        design_nos: designNos,
      },
    });
    assert(parsed.event_type === ENTITLEMENT_CHANGED, `event_type for ${action}`);
    assert(parsed.event_id === `selfcheck-ent-${action}`, `event_id for ${action}`);
    assert(parsed.data.customer_id === 42, `customer_id for ${action}`);
    assert(parsed.data.action === action, `action for ${action}`);
    assert(
      JSON.stringify(parsed.data.design_nos) === JSON.stringify(designNos),
      `design_nos for ${action}`,
    );
  }

  // Malformed / unknown action → zod reject (ingest 4xx path; no crash).
  const unknownAction = safeParseEventEnvelope({
    event_id: "selfcheck-ent-bad-action",
    event_type: ENTITLEMENT_CHANGED,
    occurred_at: "2026-08-12T17:03:00.000Z",
    data: {
      customer_id: 42,
      action: "not-a-real-action",
      design_nos: ["D-1"],
    },
  });
  assert(!unknownAction.success, "unknown entitlement action must fail parse");

  const missingCustomer = safeParseEventEnvelope({
    event_id: "selfcheck-ent-no-customer",
    event_type: ENTITLEMENT_CHANGED,
    occurred_at: "2026-08-12T17:03:00.000Z",
    data: {
      action: "grant",
      design_nos: ["D-1"],
    },
  });
  assert(!missingCustomer.success, "missing customer_id must fail parse");

  const badType = safeParseEventEnvelope({
    event_id: "selfcheck-bad-type",
    event_type: "not.a.real.event",
    occurred_at: "2026-08-12T17:03:00.000Z",
    data: {},
  });
  assert(!badType.success, "unknown event_type must fail parse");

  // Mapped-style inventory skeleton still works when product sync disabled via empty result
  // (drain leftover inventory if any).
  drainMemoryInventoryQueue();
  await handleInventorySync({
    kind: "inventory.sync",
    connectionId: "_skeleton",
    platform: "SHOPIFY",
    designNo: "SC-1",
    jobNo: "JOB-1",
    quantity: 0,
  });

  setConnectionStoreForTests(null);
  console.log("events.selfcheck ok");
}

main().catch((err) => {
  setConnectionStoreForTests(null);
  console.error(err);
  process.exit(1);
});
