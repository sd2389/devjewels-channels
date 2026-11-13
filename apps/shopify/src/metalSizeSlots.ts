/**
 * Metal × Size variant layout — one Shopify variant per combination a shopper
 * can pick, not one per stock piece.
 *
 * Every design lists 14K Yellow, White and Rose Gold, and rings list US sizes
 * 3–10 in half sizes, whether or not a piece exists. Any other metal or size we
 * actually stock is added while it is in stock. Each combination is backed by
 * its live pieces cheapest first: the first one is the piece an order takes,
 * and the count is the variant's quantity. A combination with no piece is
 * listed sold out (made to order is not offered yet).
 *
 * Pure: no I/O, so product sync, catalog import and order resolution all
 * place a piece in the same slot.
 */
import type {
  ChannelJobVariantDetails,
  ChannelMetalSizePlan,
  ChannelSlotPiece,
  ChannelVariantSlot,
} from "@devjewels-channels/core/channels/types";
import { storefrontMetalLabel } from "./products";
import { METAL_COLOR_WORDS } from "./variantMetafieldSchema";

export const METAL_OPTION = "Metal";
export const SIZE_OPTION = "Size";

/** Always listed, in the order the merchant's own picker uses. */
export const STANDARD_METALS = ["14K Yellow Gold", "14K White Gold", "14K Rose Gold"];

/** US ring sizes always listed for a ring: 3, 3.5, … 10. */
export const STANDARD_RING_SIZES = Array.from({ length: 15 }, (_, i) =>
  formatSizeNumber(3 + i * 0.5),
);

/** Shopify's variant cap per product on the API version we call. */
export const MAX_SLOT_VARIANTS = 100;

const SKU_MAX = 255;

export type SlotPiece = ChannelSlotPiece;
export type MetalSizeSlot = ChannelVariantSlot;
export type MetalSizePlan = ChannelMetalSizePlan;

export type MetalSizePlanInput = {
  designNo: string;
  /** Design category ("Ring", "Necklace", …) — decides the ring size list. */
  category?: string;
  /** The design's own size, used when a piece carries none. */
  designSize?: string;
  /** Price for a combination when no piece of the design is live. */
  fallbackPrice: number;
  pieces: SlotPiece[];
};

/** "Ring", "Rings", "Engagement Ring", "Band" — never "Earring". */
export function isRingCategory(category?: string): boolean {
  return /\b(rings?|bands?)\b/i.test(String(category || ""));
}

function formatSizeNumber(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function titleWords(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .map((w) => {
      if (/\d/.test(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .filter(Boolean)
    .join(" ");
}

/** "7 US" → "7", "7.50" → "7.5". Empty when the text holds no usable ring size. */
export function ringSizeLabel(raw?: string): string {
  const match = /(\d+(?:\.\d+)?)/.exec(String(raw || ""));
  if (!match) return "";
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n < 1 || n > 16) return "";
  return formatSizeNumber(n);
}

/** "17 INCH" → "17 Inch". */
export function otherSizeLabel(raw?: string): string {
  return titleWords(String(raw || ""));
}

/** The metal value a piece sells under; empty when the piece has no metal data. */
export function pieceMetalLabel(details?: ChannelJobVariantDetails): string {
  return storefrontMetalLabel(details);
}

/** The size value a piece sells under, given the design's layout. */
export function pieceSizeLabel(
  details: ChannelJobVariantDetails | undefined,
  input: { ring: boolean; designSize?: string },
): string {
  if (input.ring) {
    return ringSizeLabel(details?.size) || ringSizeLabel(input.designSize);
  }
  return otherSizeLabel(details?.size) || otherSizeLabel(input.designSize);
}

export function slotKey(metal: string, size?: string): string {
  return `${metal}|${size ?? ""}`.toLowerCase();
}

const COLOR_INITIAL: Record<string, string> = Object.fromEntries(
  Object.entries(METAL_COLOR_WORDS).map(([code, word]) => [word.toLowerCase(), code.toUpperCase()]),
);

/** "14K White Gold" → "14KW", "Platinum" → "PT", anything else → its letters/digits. */
export function metalSkuCode(metal: string): string {
  if (/platinum/i.test(metal)) return "PT";
  const karat = /(\d+\s*K)\b/i.exec(metal)?.[1]?.replace(/\s+/g, "").toUpperCase();
  const color = metal
    .toLowerCase()
    .split(/\s+/)
    .map((w) => COLOR_INITIAL[w])
    .find(Boolean);
  if (karat && color && /gold/i.test(metal)) return `${karat}${color}`;
  return metal.toUpperCase().replace(/[^A-Z0-9]/g, "") || "METAL";
}

export function slotSku(designNo: string, metal: string, size?: string): string {
  const parts = [designNo.trim(), metalSkuCode(metal)];
  if (size) parts.push(size.toUpperCase().replace(/\s+/g, ""));
  const sku = parts.join("-");
  return sku.length <= SKU_MAX ? sku : sku.slice(0, SKU_MAX);
}

function byPriceThenJob(a: SlotPiece, b: SlotPiece): number {
  const pa = Number.isFinite(a.price) ? a.price : Number.POSITIVE_INFINITY;
  const pb = Number.isFinite(b.price) ? b.price : Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa - pb;
  return a.jobNo.localeCompare(b.jobNo, undefined, { numeric: true });
}

function uniqueCaseless(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = v.toLowerCase();
    if (!v || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function sortSizes(values: string[], ring: boolean): string[] {
  if (!ring) return [...values].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return [...values].sort((a, b) => Number(a) - Number(b));
}

export function planMetalSizeSlots(input: MetalSizePlanInput): MetalSizePlan {
  const ring = isRingCategory(input.category);
  const unplaced: string[] = [];
  const placed: Array<{ piece: SlotPiece; metal: string; size: string }> = [];

  for (const piece of input.pieces) {
    const jobNo = piece.jobNo.trim();
    if (!jobNo) continue;
    const metal = pieceMetalLabel(piece.details);
    if (!metal) {
      unplaced.push(jobNo);
      continue;
    }
    placed.push({
      piece: { ...piece, jobNo },
      metal,
      size: pieceSizeLabel(piece.details, { ring, designSize: input.designSize }),
    });
  }

  const standardKeys = new Set(STANDARD_METALS.map((m) => m.toLowerCase()));
  const extraMetals = uniqueCaseless(placed.map((p) => p.metal))
    .filter((m) => !standardKeys.has(m.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
  const metalValues = [...STANDARD_METALS, ...extraMetals];

  const stockedSizes = uniqueCaseless(placed.map((p) => p.size).filter(Boolean));
  const designSizeLabel = ring ? ringSizeLabel(input.designSize) : otherSizeLabel(input.designSize);
  let sizeValues: string[];
  if (ring) {
    sizeValues = sortSizes(uniqueCaseless([...STANDARD_RING_SIZES, ...stockedSizes]), true);
  } else {
    sizeValues = sortSizes(
      uniqueCaseless([...stockedSizes, ...(designSizeLabel ? [designSizeLabel] : [])]),
      false,
    );
  }
  // A non-ring piece with no size of its own sits under the design's size; with
  // no sizes anywhere the product simply has no Size option.
  const sizeFor = (size: string): string | undefined => {
    if (!sizeValues.length) return undefined;
    if (size) return sizeValues.find((v) => v.toLowerCase() === size.toLowerCase()) ?? size;
    return designSizeLabel || sizeValues[0];
  };

  const allPrices = placed.map((p) => p.piece.price).filter((n) => Number.isFinite(n) && n > 0);
  const emptyPrice = allPrices.length ? Math.min(...allPrices) : input.fallbackPrice;

  const slots: MetalSizeSlot[] = [];
  const byKey = new Map<string, MetalSizeSlot>();
  for (const metal of metalValues) {
    const sizes: Array<string | undefined> = sizeValues.length ? sizeValues : [undefined];
    for (const size of sizes) {
      const slot: MetalSizeSlot = {
        key: slotKey(metal, size),
        metal,
        size,
        sku: slotSku(input.designNo, metal, size),
        pieces: [],
        quantity: 0,
        price: emptyPrice,
      };
      slots.push(slot);
      byKey.set(slot.key, slot);
    }
  }

  for (const p of placed) {
    const metal = metalValues.find((m) => m.toLowerCase() === p.metal.toLowerCase()) ?? p.metal;
    const slot = byKey.get(slotKey(metal, sizeFor(p.size)));
    if (slot) slot.pieces.push(p.piece);
    else unplaced.push(p.piece.jobNo);
  }

  for (const slot of slots) {
    slot.pieces.sort(byPriceThenJob);
    slot.quantity = slot.pieces.length;
    const backing = slot.pieces[0];
    if (backing && Number.isFinite(backing.price) && backing.price > 0) slot.price = backing.price;
  }

  if (slots.length > MAX_SLOT_VARIANTS) {
    throw new Error(
      `metal_size_layout_too_many_variants: ${input.designNo} needs ${slots.length} (max ${MAX_SLOT_VARIANTS})`,
    );
  }

  return { metalValues, sizeValues, slots, unplaced };
}
