/**
 * Map DevJewels design taxonomy fields → Shopify productType + tags.
 */

export type DesignShopifyTaxonomy = {
  productType?: string;
  tags: string[];
};

function clean(raw: unknown): string {
  return String(raw ?? "").trim();
}

function pushTag(out: string[], seen: Set<string>, raw: unknown): void {
  const t = clean(raw);
  if (!t) return;
  const key = t.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push(t);
}

/**
 * category → productType; collection / subcategory / producttype → tags.
 */
export function resolveDesignShopifyTaxonomy(input: {
  category?: unknown;
  collection?: unknown;
  subcategory?: unknown;
  producttype?: unknown;
}): DesignShopifyTaxonomy {
  const productType = clean(input.category) || undefined;
  const tags: string[] = [];
  const seen = new Set<string>();
  pushTag(tags, seen, input.collection);
  pushTag(tags, seen, input.subcategory);
  pushTag(tags, seen, input.producttype);
  return { productType, tags };
}

/** Small assert-based check — fails if taxonomy mapping regresses. */
export function designShopifyTaxonomySelfcheck(): void {
  const got = resolveDesignShopifyTaxonomy({
    category: "Earring",
    collection: "CUFF",
    subcategory: "FASHION",
    producttype: "MULTISHAPE",
  });
  if (got.productType !== "Earring") {
    throw new Error(`expected productType Earring, got ${got.productType}`);
  }
  if (got.tags.join(",") !== "CUFF,FASHION,MULTISHAPE") {
    throw new Error(`unexpected tags: ${got.tags.join(",")}`);
  }
  const empty = resolveDesignShopifyTaxonomy({});
  if (empty.productType !== undefined || empty.tags.length !== 0) {
    throw new Error("empty taxonomy should yield no productType/tags");
  }
}

