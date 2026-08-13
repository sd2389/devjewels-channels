import { NextResponse } from "next/server";

/**
 * Ownership map + Phase 3 stub.
 * Runtime also mirrored at apps/core/src/app/api/woocommerce/webhooks/route.ts
 */
export async function POST() {
  return NextResponse.json(
    {
      accepted: false,
      message: "WooCommerce webhooks — Phase 3 stub",
    },
    { status: 501 },
  );
}
