import { NextResponse } from "next/server";

/** Phase 3 placeholder — handler will live in apps/woocommerce. */
export async function POST() {
  return NextResponse.json(
    {
      accepted: false,
      message: "WooCommerce webhooks — Phase 3 stub",
    },
    { status: 501 },
  );
}
