/**
 * Resolve Shopify/channel unit price from Customer API price funnel (+ markup).
 * Inventory/design totamt is only a fallback when getPrice fails or prices are denied.
 *
 * Formula: funnel final_price → design override if present else connection overall → Shopify.
 */
import { deverpClient } from "@/integrations/deverp/client";
import {
  applyConnectionMarkup,
  pickChannelMarkup,
  type MarkupMode,
} from "@/services/markup";

function parsePrice(raw: unknown): number {
  const n =
    typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? "0"));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export type ResolveChannelVariantPriceInput = {
  customerId: number | null | undefined;
  designNo: string;
  jobNo: string;
  /** Inventory/design totamt fallback when funnel price unavailable. */
  fallbackPrice: number;
  canViewPrices: boolean;
  /** Connection overall markup (used when no design override). */
  markupMode?: MarkupMode | string | null;
  markupValue?: number | string | null;
  markupBps?: number | null;
  /** Per-design override; wins over connection overall when set. */
  designMarkup?: { markupMode: MarkupMode | string; markupValue: number } | null;
};

/**
 * Prefer PriceManager funnel (`final_price`) when customer can view prices.
 */
export async function resolveChannelVariantPrice(
  input: ResolveChannelVariantPriceInput,
): Promise<number> {
  let unitPrice = parsePrice(input.fallbackPrice);

  if (!input.canViewPrices) {
    return 0;
  }

  if (input.customerId != null) {
    try {
      const priced = await deverpClient.getPrice({
        customerId: input.customerId,
        designNo: input.designNo,
        jobNo: input.jobNo === input.designNo ? undefined : input.jobNo,
      });
      unitPrice = parsePrice(priced.final_price);
    } catch {
      // keep inventory/design totamt fallback
    }
  }

  const markup = pickChannelMarkup({
    overall: {
      markupMode: input.markupMode,
      markupValue: input.markupValue,
      markupBps: input.markupBps,
    },
    designOverride: input.designMarkup ?? null,
  });

  return applyConnectionMarkup(unitPrice, markup);
}
