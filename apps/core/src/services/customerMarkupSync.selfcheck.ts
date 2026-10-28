/**
 * Assert customer markup apply upserts/clears and enqueues product.sync.
 * Run: npx tsx apps/core/src/services/customerMarkupSync.selfcheck.ts
 */
import {
  createMemoryConnectionStore,
  setConnectionStoreForTests,
  type ConnectionRow,
} from "@/services/connections";
import {
  createMemoryConnectionDesignMarkupStore,
  setConnectionDesignMarkupStoreForTests,
} from "@/services/connectionDesignMarkups";
import { applyCustomerDesignMarkupsAndSync } from "@/services/customerMarkupSync";

function connection(): ConnectionRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    platform: "SHOPIFY",
    name: "customer-markup-selfcheck",
    is_active: true,
    credentials_secret_ref: null,
    customer_id: 42,
    markup_mode: "none",
    markup_value: 0,
    markup_bps: 0,
    sync_inventory: true,
    sync_price: true,
    sync_products: true,
    sync_product_content: false,
    sync_orders: true,
  };
}

async function main(): Promise<void> {
  delete process.env.PRODUCT_SYNC_QUEUE_URL;
  setConnectionStoreForTests(createMemoryConnectionStore([connection()]));
  setConnectionDesignMarkupStoreForTests(createMemoryConnectionDesignMarkupStore());

  const applied = await applyCustomerDesignMarkupsAndSync({
    customerId: 42,
    designMarkups: [
      { designNo: "DE-1", markupMode: "percent", markupValue: 10 },
      { designNo: "DE-2", markupMode: "multiplier", markupValue: 3 },
    ],
    sync: true,
  });
  if (applied.connections_touched !== 1) {
    throw new Error(`connections_touched=${applied.connections_touched}`);
  }
  if (applied.designs_upserted !== 2) {
    throw new Error(`designs_upserted=${applied.designs_upserted}`);
  }
  if (applied.sync_enqueued !== 2) {
    throw new Error(`sync_enqueued=${applied.sync_enqueued}`);
  }

  const cleared = await applyCustomerDesignMarkupsAndSync({
    customerId: 42,
    designMarkups: [{ designNo: "DE-1", markupMode: "none", markupValue: 0 }],
    sync: false,
  });
  if (cleared.designs_cleared !== 1) {
    throw new Error(`designs_cleared=${cleared.designs_cleared}`);
  }
  if (cleared.sync_enqueued !== 0) {
    throw new Error(`sync should be off: ${cleared.sync_enqueued}`);
  }

  console.log("customerMarkupSync.selfcheck OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
