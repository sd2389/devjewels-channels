/**
 * Metal × Size layout in core: order lines resolve a slot to its cheapest live
 * piece, stock events re-sync the design, and a sync records its slots.
 *
 * Run: npm run selfcheck:metal-size -w @devjewels-channels/core
 */
import type { CommerceChannel, SyncMetalSizeVariantsInput } from "@/channels/types";
import { setStoreApiClientForTests, type StoreApiClient } from "@/integrations/storeApi/client";
import { pickSlotPieces, resolveChannelOrderLines } from "./channelOrderLineResolve";
import {
  connectionVariantLayout,
  createMemoryConnectionStore,
  setConnectionStoreForTests,
  updateConnectionCatalogLayout,
  type ConnectionRow,
} from "./connections";
import { metalSizeConnectionsToResync } from "./inventoryFanOut";
import { syncDesignMetalSize } from "./metalSizeSync";
import { createMemoryProductMappingStore, setProductMappingStoreForTests } from "./productMappings";
import {
  createMemoryVariantMappingStore,
  setVariantMappingStoreForTests,
} from "./variantMappings";
import {
  createMemoryVariantSlotStore,
  getVariantSlotStore,
  setVariantSlotStoreForTests,
} from "./variantSlots";

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok  ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

const CONN = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function connection(extra: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: CONN,
    platform: "SHOPIFY",
    name: "B&B",
    is_active: true,
    credentials_secret_ref: "vault:x",
    customer_id: 907,
    markup_mode: "none",
    markup_value: 0,
    markup_bps: 0,
    sync_inventory: true,
    sync_price: true,
    sync_products: true,
    sync_product_content: false,
    sync_orders: true,
    variant_layout: "metal_size",
    sync_product_description: true,
    ...extra,
  };
}

function storeApiWithLiveJobs(live: string[]): StoreApiClient {
  return {
    async getInventory(designNo: string) {
      return {
        design_no: designNo,
        job_no: null,
        available_count: live.length,
        truncated: false,
        jobs: live.map((job_no) => ({ design_no: designNo, job_no })),
      };
    },
  } as unknown as StoreApiClient;
}

async function main(): Promise<void> {
  console.log("picking pieces");
  const taken = new Set<string>();
  check(
    "cheapest live piece first",
    JSON.stringify(pickSlotPieces({ slotJobNos: ["A", "B", "C"], liveJobNos: new Set(["B", "C"]), taken, quantity: 1 })) === '["B"]',
  );
  check(
    "a second line of the same order never takes the same piece",
    JSON.stringify(pickSlotPieces({ slotJobNos: ["A", "B", "C"], liveJobNos: new Set(["B", "C"]), taken, quantity: 1 })) === '["C"]',
  );
  check(
    "short of live pieces, last-known ones fill in so Django can answer duplicate or 409",
    JSON.stringify(pickSlotPieces({ slotJobNos: ["A", "B"], liveJobNos: new Set(), taken: new Set(), quantity: 1 })) === '["A"]',
  );

  console.log("order lines");
  setVariantMappingStoreForTests(createMemoryVariantMappingStore());
  setVariantSlotStoreForTests(
    createMemoryVariantSlotStore([
      {
        connection_id: CONN,
        design_no: "DR-1055",
        slot_key: "14k white gold|7",
        sku: "DR-1055-14KW-7",
        external_variant_id: "gid://shopify/ProductVariant/55",
        external_inventory_item_id: "gid://shopify/InventoryItem/55",
        job_nos: ["33831", "34835", "32968"],
      },
      {
        connection_id: CONN,
        design_no: "DR-1055",
        slot_key: "14k rose gold|6",
        sku: "DR-1055-14KR-6",
        external_variant_id: "gid://shopify/ProductVariant/56",
        external_inventory_item_id: "gid://shopify/InventoryItem/56",
        job_nos: [],
      },
    ]),
  );
  // 33831 sold elsewhere since the last sync.
  setStoreApiClientForTests(storeApiWithLiveJobs(["34835", "32968"]));
  const two = await resolveChannelOrderLines({
    connectionId: CONN,
    metalSizeLayout: true,
    payload: { id: 1, line_items: [{ id: 10, variant_id: 55, sku: "DR-1055-14KW-7", quantity: 2 }] },
  });
  check(
    "quantity 2 becomes the two cheapest live pieces, one line each",
    JSON.stringify(two.lines.map((l) => [l.designNo, l.jobNo, l.quantity])) ===
      '[["DR-1055","34835",1],["DR-1055","32968",1]]',
    JSON.stringify(two.lines),
  );
  const bySku = await resolveChannelOrderLines({
    connectionId: CONN,
    metalSizeLayout: true,
    payload: { id: 2, line_items: [{ id: 11, sku: "DR-1055-14KW-7", quantity: 1 }] },
  });
  check("a line with only a SKU still finds its slot", bySku.lines[0]?.jobNo === "34835", JSON.stringify(bySku.lines));
  const empty = await resolveChannelOrderLines({
    connectionId: CONN,
    metalSizeLayout: true,
    payload: { id: 3, line_items: [{ id: 12, variant_id: 56, sku: "DR-1055-14KR-6", quantity: 1 }] },
  });
  check("an empty slot reserves nothing", empty.lines.length === 0 && empty.skippedUnmapped === 1);
  const pieceStore = await resolveChannelOrderLines({
    connectionId: CONN,
    payload: { id: 4, line_items: [{ id: 13, variant_id: 55, sku: "DR-1055-14KW-7", quantity: 1 }] },
  });
  check(
    "a piece-layout store never reads slots",
    pieceStore.lines.length === 0 && pieceStore.skippedUnmapped === 1,
    JSON.stringify(pieceStore.lines),
  );

  console.log("stock events");
  const piece = connection({ id: "p1", customer_id: 1, variant_layout: "piece" });
  const slots = connection({ id: "m1", customer_id: 2 });
  const notEntitled = connection({ id: "m2", customer_id: 3 });
  const noInventory = connection({ id: "m3", customer_id: 4, sync_inventory: false });
  const resync = metalSizeConnectionsToResync([piece, slots, notEntitled, noInventory], new Set([1, 2, 4]));
  check(
    "only entitled Metal × Size stores with inventory sync re-sync the design",
    JSON.stringify(resync.map((c) => c.id)) === '["m1"]',
    JSON.stringify(resync.map((c) => c.id)),
  );
  check(
    "rows from before migration 005 read as the piece layout",
    connectionVariantLayout({}) === "piece" && connectionVariantLayout({ variant_layout: "metal_size" }) === "metal_size",
  );

  console.log("settings");
  setConnectionStoreForTests(createMemoryConnectionStore([connection({ variant_layout: "piece", sync_product_description: false })]));
  const switched = await updateConnectionCatalogLayout(CONN, { variantLayout: "metal_size", syncProductDescription: true });
  check(
    "a store switches to Metal × Size with the description on",
    switched?.variant_layout === "metal_size" && switched.sync_product_description === true,
  );

  console.log("sync bookkeeping");
  setProductMappingStoreForTests(createMemoryProductMappingStore());
  setVariantSlotStoreForTests(
    createMemoryVariantSlotStore([
      {
        connection_id: CONN,
        design_no: "DR-1055",
        slot_key: "stale|slot",
        sku: "OLD",
        external_variant_id: "gid://shopify/ProductVariant/1",
        external_inventory_item_id: null,
        job_nos: ["X"],
      },
    ]),
  );
  let sent: SyncMetalSizeVariantsInput | null = null;
  const adapter = {
    platform: "SHOPIFY",
    async syncMetalSizeVariants(input: SyncMetalSizeVariantsInput) {
      sent = input;
      await input.onExternalProductId?.("gid://shopify/Product/7");
      return {
        externalProductId: "gid://shopify/Product/7",
        slots: input.plan.slots.map((s, i) => ({
          key: s.key,
          sku: s.sku,
          externalVariantId: `gid://shopify/ProductVariant/${i + 100}`,
          externalInventoryItemId: `gid://shopify/InventoryItem/${i + 100}`,
          jobNos: s.pieces.map((p) => p.jobNo),
        })),
      };
    },
  } as unknown as CommerceChannel;
  const result = await syncDesignMetalSize({
    connection: connection(),
    adapter,
    designNo: "DR-1055",
    title: "DR-1055",
    imageUrls: [],
    tags: [],
    category: "Ring",
    canViewPrices: false,
    pieces: [
      { jobNo: "34835", price: 3300, details: { metal: "Gold", purity: "14K", color: "W", size: "7" } },
      { jobNo: "33831", price: 3100, details: { metal: "Gold", purity: "14K", color: "W", size: "7" } },
    ],
    fallbackPrice: 3000,
    writeInventory: true,
  });
  const sentInput = sent as SyncMetalSizeVariantsInput | null;
  check("creates when nothing is mapped", result.outcome === "CREATED");
  check("passes the description flag through", sentInput?.syncProductDescription === true);
  check("no cost without price permission", sentInput?.includeCost === false);
  const stored = await getVariantSlotStore().listByDesign(CONN, "DR-1055");
  check("records one slot row per variant", stored.length === 45, String(stored.length));
  check("drops slots the plan no longer has", !stored.some((r) => r.slot_key === "stale|slot"));
  check(
    "a slot row lists its pieces cheapest first",
    JSON.stringify(stored.find((r) => r.sku === "DR-1055-14KW-7")?.job_nos) === '["33831","34835"]',
  );
  check(
    "the log line counts variants, stock and pieces",
    result.variants === 45 && result.inStock === 1 && result.pieces === 2,
  );

  setStoreApiClientForTests(null);
  setVariantSlotStoreForTests(null);
  setVariantMappingStoreForTests(null);
  setProductMappingStoreForTests(null);
  setConnectionStoreForTests(null);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nmetal × size core selfcheck passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
