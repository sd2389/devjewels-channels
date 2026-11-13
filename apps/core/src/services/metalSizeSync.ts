/**
 * Metal × Size layout for one design, shared by product sync and catalog import.
 *
 * Takes the live pieces the caller already priced and detailed, places them in
 * slots (cheapest first), writes the product in one adapter call, then records
 * the product mapping and the design's variant slots. Quantities are written in
 * the same pass, so no per-piece inventory.sync messages follow.
 */
import type {
  ChannelJobVariantDetails,
  CommerceChannel,
} from "@/channels/types";
import { InventorySkipError } from "@/channels/types";
import type { ConnectionRow } from "@/services/connections";
import { upsertProductMapping } from "@/services/productMappings";
import { getVariantSlotStore } from "@/services/variantSlots";
import { planMetalSizeSlots } from "@devjewels-channels/shopify/metalSizeSlots";

export type MetalSizeDesignInput = {
  connection: ConnectionRow;
  adapter: CommerceChannel;
  designNo: string;
  title: string;
  imageUrls: string[];
  productType?: string;
  tags: string[];
  category: string;
  existingProductId?: string;
  canViewPrices: boolean;
  /** Real live pieces only — never the design_no placeholder of a sold-out design. */
  pieces: Array<{ jobNo: string; price: number; wholesaleCost?: number; details?: ChannelJobVariantDetails }>;
  /** Price for combinations when no piece of the design is live. */
  fallbackPrice: number;
  /** Write quantities: sync_inventory on, or a zeroing after inventory access was lost. */
  writeInventory: boolean;
};

export type MetalSizeDesignResult = {
  outcome: "CREATED" | "UPDATED";
  externalProductId: string;
  variants: number;
  inStock: number;
  pieces: number;
  unplaced: string[];
};

export async function syncDesignMetalSize(
  input: MetalSizeDesignInput,
): Promise<MetalSizeDesignResult> {
  const { connection, adapter, designNo } = input;
  if (!adapter.syncMetalSizeVariants) {
    throw new InventorySkipError(
      "metal_size_not_supported",
      `${adapter.platform} has no Metal × Size layout`,
    );
  }
  const plan = planMetalSizeSlots({
    designNo,
    category: input.category,
    fallbackPrice: input.fallbackPrice,
    pieces: input.pieces,
  });

  const result = await adapter.syncMetalSizeVariants({
    connectionId: connection.id,
    designNo,
    title: input.title,
    credentialsSecretRef: connection.credentials_secret_ref ?? undefined,
    imageUrls: input.imageUrls,
    productType: input.productType,
    tags: input.tags,
    syncProductContent: connection.sync_product_content,
    syncProductDescription: connection.sync_product_description ?? false,
    externalProductId: input.existingProductId,
    plan,
    includeCost: input.canViewPrices,
    writeInventory: input.writeInventory,
    onExternalProductId: async (externalProductId) => {
      await upsertProductMapping({ connectionId: connection.id, designNo, externalProductId });
    },
  });

  await upsertProductMapping({
    connectionId: connection.id,
    designNo,
    externalProductId: result.externalProductId,
  });
  await getVariantSlotStore().replaceForDesign(
    connection.id,
    designNo,
    result.slots.map((s) => ({
      slot_key: s.key,
      sku: s.sku,
      external_variant_id: s.externalVariantId,
      external_inventory_item_id: s.externalInventoryItemId ?? null,
      job_nos: s.jobNos,
    })),
  );

  if (plan.unplaced.length) {
    console.warn("metal_size_pieces_unplaced", {
      connectionId: connection.id,
      designNo,
      jobNos: plan.unplaced.slice(0, 20),
    });
  }

  return {
    outcome: input.existingProductId ? "UPDATED" : "CREATED",
    externalProductId: result.externalProductId,
    variants: plan.slots.length,
    inStock: plan.slots.filter((s) => s.quantity > 0).length,
    pieces: plan.slots.reduce((n, s) => n + s.pieces.length, 0),
    unplaced: plan.unplaced,
  };
}

/** One-line sync_log summary. */
export function metalSizeLogMessage(r: MetalSizeDesignResult): string {
  return `metal_size variants=${r.variants} in_stock=${r.inStock} pieces=${r.pieces} unplaced=${r.unplaced.length}`;
}

/**
 * Take every slot variant of a design off sale (entitlement revoked). The
 * product, its page and its mappings stay, so re-entitlement restores stock.
 */
export async function zeroDesignMetalSizeSlots(input: {
  connection: ConnectionRow;
  adapter: CommerceChannel;
  designNo: string;
}): Promise<number> {
  const slots = await getVariantSlotStore().listByDesign(input.connection.id, input.designNo);
  let zeroed = 0;
  for (const slot of slots) {
    if (!slot.external_inventory_item_id) continue;
    await input.adapter.updateInventory({
      connectionId: input.connection.id,
      designNo: input.designNo,
      jobNo: slot.sku,
      quantity: 0,
      externalInventoryItemId: slot.external_inventory_item_id,
      credentialsSecretRef: input.connection.credentials_secret_ref ?? undefined,
    });
    zeroed += 1;
  }
  return zeroed;
}
