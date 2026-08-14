/**
 * Selfcheck: design override wins over connection overall after funnel price.
 * Run: npx tsx apps/core/src/services/connectionDesignMarkups.selfcheck.ts
 */
import {
  createMemoryConnectionDesignMarkupStore,
  normalizeDesignNoKey,
} from "./connectionDesignMarkups";
import { applyConnectionMarkup, pickChannelMarkup } from "./markup";

async function main(): Promise<void> {
  const store = createMemoryConnectionDesignMarkupStore();
  const connectionId = "11111111-1111-1111-1111-111111111111";

  await store.replaceAll(connectionId, [
    { designNo: "DE-300", markupMode: "multiplier", markupValue: 3 },
  ]);

  const overall = { markupMode: "percent" as const, markupValue: 20 };
  const map = new Map<string, { markupMode: string; markupValue: number }>();
  for (const row of await store.listByConnection(connectionId)) {
    map.set(normalizeDesignNoKey(row.design_no), {
      markupMode: row.markup_mode,
      markupValue: row.markup_value,
    });
  }

  const funnelPrice = 100;
  const a = applyConnectionMarkup(
    funnelPrice,
    pickChannelMarkup({
      overall,
      designOverride: map.get("DE-100") ?? null,
    }),
  );
  const c = applyConnectionMarkup(
    funnelPrice,
    pickChannelMarkup({
      overall,
      designOverride: map.get("DE-300") ?? null,
    }),
  );

  if (a !== 120) {
    throw new Error(`DE-100 should use overall +20% → 120, got ${a}`);
  }
  if (c !== 300) {
    throw new Error(`DE-300 should use design ×3 → 300, got ${c}`);
  }

  // Denied path: multiplier 0 is ignored by applyConnectionMarkup (passthrough)
  const bad = applyConnectionMarkup(100, {
    markupMode: "multiplier",
    markupValue: 0,
  });
  if (bad !== 100) {
    throw new Error(`multiplier 0 should passthrough, got ${bad}`);
  }

  console.log("connectionDesignMarkups.selfcheck ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
