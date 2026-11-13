/**
 * The product description as the customer stock table: one row per live piece,
 * cheapest first, the format Buffed & Bubbly had before PR #22.
 *
 * No Price column. The description is public, and for a store that pushes our
 * price unchanged it would print DevJewels' price on their storefront.
 * `border` is an HTML attribute so the grid still shows if a theme strips CSS.
 */
import type { ChannelJobVariantDetails } from "@devjewels-channels/core/channels/types";
import type { ShopifyAdminClient } from "./client";
import { displayToken, throwGraphqlErrors, throwUserErrors } from "./products";

/** Cap rows so a design with hundreds of pieces cannot grow a multi-MB description. */
export const DESCRIPTION_PIECE_CAP = 40;

export type DescriptionPiece = { jobNo: string; details?: ChannelJobVariantDetails };

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function text(raw: string | undefined): string {
  return String(raw || "").trim();
}

type Column = {
  label: string;
  /** The stock table always shows these, even with a blank cell. */
  always: boolean;
  cell: (p: DescriptionPiece) => string;
};

const COLUMNS: Column[] = [
  { label: "Job No", always: true, cell: (p) => text(p.jobNo) },
  { label: "Metal", always: true, cell: (p) => displayToken(p.details?.metal || "") },
  { label: "Quality", always: true, cell: (p) => displayToken(p.details?.purity || "") },
  { label: "Color", always: true, cell: (p) => displayToken(p.details?.color || "") },
  { label: "Type", always: false, cell: (p) => text(p.details?.diamondType) },
  { label: "Dia Quality", always: true, cell: (p) => text(p.details?.diaQly) },
  { label: "Dia Color", always: true, cell: (p) => text(p.details?.diaClr) },
  { label: "Gold WT", always: true, cell: (p) => text(p.details?.gwt) },
  { label: "Net WT", always: false, cell: (p) => text(p.details?.nwt) },
  { label: "Diamond WT", always: false, cell: (p) => text(p.details?.dwt) },
  { label: "Stone WT", always: false, cell: (p) => text(p.details?.swt) },
  { label: "Size", always: false, cell: (p) => text(p.details?.size) },
  { label: "Store", always: false, cell: (p) => text(p.details?.store) },
  { label: "Certificate", always: false, cell: (p) => text(p.details?.certificate) },
];

/** `pieces` in the order to show them — callers pass cheapest first. */
export function stockTableDescriptionHtml(designNo: string, pieces: DescriptionPiece[]): string {
  const live = pieces.filter((p) => text(p.jobNo));
  if (!live.length) {
    return `<h3>Made to order — ${escapeHtml(designNo)}</h3>\n<p>No pieces in stock right now.</p>`;
  }
  const rows = live.slice(0, DESCRIPTION_PIECE_CAP);
  const columns = COLUMNS.filter((c) => c.always || rows.some((r) => c.cell(r)));
  const head = columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("\n");
  const body = rows
    .map((r) => {
      const cells = columns
        .map((c) => {
          const value = c.cell(r);
          return `<td>${value ? escapeHtml(value) : "—"}</td>`;
        })
        .join("\n");
      return `<tr>\n${cells}\n</tr>`;
    })
    .join("\n");
  const capped = live.length > DESCRIPTION_PIECE_CAP;
  const count = capped ? `${rows.length} of ${live.length}` : String(rows.length);
  const more = capped
    ? `\n<p>+${live.length - DESCRIPTION_PIECE_CAP} more pieces are in stock.</p>`
    : "";
  return `<h3>In Stock (${count}) — ${escapeHtml(designNo)}</h3>
<table border="1" cellpadding="6" cellspacing="0">
<thead><tr>
${head}
</tr></thead>
<tbody>
${body}
</tbody>
</table>${more}`;
}

const PRODUCT_DESCRIPTION_UPDATE = /* GraphQL */ `
  mutation productUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/** Write the stock table into descriptionHtml — the only product field sent. */
export async function writeShopifyStockDescription(
  client: ShopifyAdminClient,
  productId: string,
  designNo: string,
  pieces: DescriptionPiece[],
): Promise<void> {
  const updated = await client.graphql<{
    productUpdate?: { userErrors?: Array<{ field?: string[]; message: string }> };
  }>(PRODUCT_DESCRIPTION_UPDATE, {
    product: { id: productId, descriptionHtml: stockTableDescriptionHtml(designNo, pieces) },
  });
  throwGraphqlErrors(updated.errors);
  throwUserErrors(updated.data?.productUpdate?.userErrors, "productUpdate");
}

/** Pieces as the table lists them: cheapest first, job number breaking ties. */
export function cheapestFirst<T extends { jobNo: string; price: number }>(pieces: T[]): T[] {
  return [...pieces].sort(
    (a, b) => a.price - b.price || a.jobNo.localeCompare(b.jobNo, undefined, { numeric: true }),
  );
}
