/**
 * Resolve public CDN image URLs for Shopify productCreateMedia.
 * Builds White / Yellow / Rose (+ Live) and angles 1–3 so all metal colors sync.
 */

const CDN_BASE = "https://cdn.devjewels.com";

/** Metal folders on CDN (matches ImageConfig.SUPPORTED_COLORS). */
const METAL_COLORS = ["White", "Yellow", "Rose"] as const;
const LIVE_FOLDER = "Live";
/** Image angles per color: D_-1, H_-2, -3 (matches frontend thumbnail helpers). */
const IMAGE_NUMBERS = [1, 2, 3] as const;
/** Cap so Shopify create stays bounded (3 metals × 3 + Live). */
const MAX_IMAGES = 12;

function normalizeColor(raw: unknown): string {
  const s = String(raw || "").trim();
  if (!s) return "White";
  const upper = s.toUpperCase();
  if (upper === "Y" || s === "Yellow") return "Yellow";
  if (upper === "W" || s === "White") return "White";
  if (upper === "R" || upper === "RG" || s === "Rose" || s === "Rose Gold") {
    return "Rose";
  }
  if (s === "Live") return LIVE_FOLDER;
  return s;
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function designBase(designNo: string, imageBasePath: string): string {
  const base = imageBasePath.replace(/\/$/, "").trim();
  if (base && isHttpUrl(base)) return base;
  return `${CDN_BASE}/products/${designNo}`;
}

function filenameFor(designNo: string, imageNumber: number): string {
  if (imageNumber === 1) return `D_${designNo}-1.jpg`;
  if (imageNumber === 2) return `H_${designNo}-2.jpg`;
  return `${designNo}-${imageNumber}.jpg`;
}

function buildColorUrl(
  designNo: string,
  base: string,
  color: string,
  imageNumber: number,
): string {
  return `${base}/${color}/${filenameFor(designNo, imageNumber)}`;
}

/**
 * Prefer default metal color first, then other metals, then Live.
 * Always expands to all metal colors (facade often only returns one thumbnail).
 */
export function resolveDesignImageUrls(input: {
  designNo: string;
  imageUrls?: unknown;
  thumbnailUrl?: unknown;
  imageBasePath?: unknown;
  defaultColor?: unknown;
}): string[] {
  const designNo = String(input.designNo || "").trim();
  if (!designNo) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    const u = String(raw || "").trim();
    if (!u || !isHttpUrl(u) || seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };

  const defaultColor = normalizeColor(input.defaultColor);
  const base = designBase(designNo, String(input.imageBasePath || ""));

  // Default color first (all angles), then remaining metals, then Live #1.
  const colorOrder = [
    defaultColor,
    ...METAL_COLORS.filter((c) => c !== defaultColor),
  ];

  for (const color of colorOrder) {
    for (const n of IMAGE_NUMBERS) {
      push(buildColorUrl(designNo, base, color, n));
    }
  }
  push(buildColorUrl(designNo, base, LIVE_FOLDER, 1));

  // Keep any explicit facade URLs at the front if not already included.
  if (Array.isArray(input.imageUrls)) {
    for (const u of [...input.imageUrls].reverse()) {
      const url = String(u || "").trim();
      if (!url || !isHttpUrl(url)) continue;
      if (seen.has(url)) {
        // move to front
        const idx = out.indexOf(url);
        if (idx > 0) {
          out.splice(idx, 1);
          out.unshift(url);
        }
        continue;
      }
      out.unshift(url);
      seen.add(url);
    }
  }
  const thumb = String(input.thumbnailUrl || "").trim();
  if (thumb && isHttpUrl(thumb) && !seen.has(thumb)) {
    out.unshift(thumb);
  } else if (thumb && seen.has(thumb)) {
    const idx = out.indexOf(thumb);
    if (idx > 0) {
      out.splice(idx, 1);
      out.unshift(thumb);
    }
  }

  return out.slice(0, MAX_IMAGES);
}
