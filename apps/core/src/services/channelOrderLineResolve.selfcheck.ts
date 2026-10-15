/**
 * Resolve Shopify lines via variant_mapping when properties are absent.
 * Run: npm run selfcheck:channel-order-lines -w @devjewels-channels/core
 */
import {
  applyResolvedLines,
  resolveChannelOrderLines,
} from "./channelOrderLineResolve";
import {
  createMemoryVariantMappingStore,
  setVariantMappingStoreForTests,
} from "./variantMappings";

const CONN = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  setVariantMappingStoreForTests(
    createMemoryVariantMappingStore([
      {
        id: "1",
        connection_id: CONN,
        design_no: "RING-1",
        job_no: "27650-2",
        external_variant_id: "gid://shopify/ProductVariant/99",
        external_inventory_item_id: "gid://shopify/InventoryItem/99",
      },
    ]),
  );

  const byVariant = await resolveChannelOrderLines({
    connectionId: CONN,
    payload: {
      id: 1,
      line_items: [
        {
          id: 10,
          variant_id: 99,
          sku: "27650-2",
          quantity: 1,
        },
        {
          id: 11,
          sku: "MERCHANT-OWN",
          quantity: 2,
        },
      ],
    },
  });
  assert(byVariant.lines.length === 1, "one DevJewels line");
  assert(byVariant.lines[0]?.designNo === "RING-1", "design from mapping");
  assert(byVariant.lines[0]?.jobNo === "27650-2", "job from mapping");
  assert(byVariant.skippedUnmapped === 1, "merchant SKU skipped");

  const bySku = await resolveChannelOrderLines({
    connectionId: CONN,
    payload: {
      id: 2,
      line_items: [{ id: 20, sku: "27650-2", quantity: 1 }],
    },
  });
  assert(bySku.lines[0]?.designNo === "RING-1", "SKU→job mapping");

  const withProps = await resolveChannelOrderLines({
    connectionId: CONN,
    payload: {
      id: 3,
      line_items: [
        {
          id: 30,
          sku: "ignored",
          quantity: 1,
          properties: [
            { name: "design_no", value: "PROP-D" },
            { name: "job_no", value: "PROP-J" },
          ],
        },
      ],
    },
  });
  assert(withProps.lines[0]?.designNo === "PROP-D", "properties win");

  const applied = applyResolvedLines(
    {
      connectionId: CONN,
      platform: "SHOPIFY",
      externalOrderId: "gid://shopify/Order/1",
      currency: "USD",
      lines: [],
    },
    byVariant.lines,
  );
  assert(applied.lines.length === 1, "apply lines");

  setVariantMappingStoreForTests(null);
  console.log("channelOrderLineResolve.selfcheck OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
