/**
 * Apply connection markup to a Customer API / PriceManager base price.
 * markup_mode: none | percent | multiplier
 * - percent: price * (1 + value/100)  e.g. 10 → +10%
 * - multiplier: price * value         e.g. 3 → ×3
 * Legacy markup_bps: price * (1 + bps/10000) when mode is none and bps > 0.
 */
export type MarkupMode = "none" | "percent" | "multiplier";

export function applyConnectionMarkup(
  basePrice: number,
  input: {
    markupMode?: MarkupMode | string | null;
    markupValue?: number | string | null;
    markupBps?: number | null;
  },
): number {
  const base = Number.isFinite(basePrice) && basePrice >= 0 ? basePrice : 0;
  const mode = String(input.markupMode || "none").trim().toLowerCase();
  const rawValue = Number(input.markupValue ?? 0);
  const value = Number.isFinite(rawValue) ? rawValue : 0;

  let priced = base;
  if (mode === "percent" && value !== 0) {
    priced = base * (1 + value / 100);
  } else if (mode === "multiplier" && value > 0) {
    priced = base * value;
  } else {
    const bps = Number(input.markupBps ?? 0);
    if (Number.isFinite(bps) && bps !== 0) {
      priced = base * (1 + bps / 10000);
    }
  }

  if (!Number.isFinite(priced) || priced < 0) return 0;
  return Math.round(priced * 100) / 100;
}

/**
 * Brutal markup math selfcheck.
 * Formulas (documented + asserted):
 * - none: passthrough (legacy bps only when mode is none and bps ≠ 0)
 * - percent: price * (1 + value/100)   e.g. 10 → +10%, 100 → ×2
 * - multiplier: price * value          e.g. 3 → ×3, 1.25 → ×1.25
 */
export function markupSelfcheck(): void {
  const cases: Array<[number, Parameters<typeof applyConnectionMarkup>[1], number]> = [
    // none / passthrough
    [100, { markupMode: "none" }, 100],
    [100, { markupMode: "none", markupValue: 999 }, 100],
    [100, { markupMode: "percent", markupValue: 0 }, 100],
    [100, { markupMode: "multiplier", markupValue: 0 }, 100],
    // percent
    [100, { markupMode: "percent", markupValue: 10 }, 110],
    [100, { markupMode: "percent", markupValue: 100 }, 200],
    [80, { markupMode: "percent", markupValue: 12.5 }, 90],
    // multiplier (incl ×3)
    [100, { markupMode: "multiplier", markupValue: 3 }, 300],
    [100, { markupMode: "multiplier", markupValue: 1.0 }, 100],
    [100, { markupMode: "multiplier", markupValue: 1.25 }, 125],
    [40, { markupMode: "multiplier", markupValue: 2.5 }, 100],
    // legacy bps when mode none
    [100, { markupMode: "none", markupBps: 500 }, 105],
  ];
  for (const [base, opts, expected] of cases) {
    const got = applyConnectionMarkup(base, opts);
    if (got !== expected) {
      throw new Error(
        `markupSelfcheck failed: ${base} ${JSON.stringify(opts)} → ${got} (want ${expected})`,
      );
    }
  }
}
