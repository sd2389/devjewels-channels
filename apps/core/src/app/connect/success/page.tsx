import Link from "next/link";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_invite: "This install link is invalid or has expired. Ask DevJewels staff for a new link.",
  invite_used: "This install link was already used. Ask DevJewels staff for a new link.",
  missing_oauth_params: "Shopify install was cancelled or incomplete.",
  invalid_hmac: "Shopify install failed a security check. Try again from your install link.",
  invalid_state: "Install session expired. Open your install link again.",
  oauth_not_configured: "Shopify app is not configured yet. Contact DevJewels staff.",
  missing_customer: "Install link is missing customer context. Contact DevJewels staff.",
  connect_failed: "Could not finish connecting your store. Contact DevJewels staff.",
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ConnectSuccessPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const connected = params.connected === "1";
  const errorCode =
    typeof params.shopify_error === "string" ? params.shopify_error : null;
  const reconnected = params.reconnected === "1";

  const errorMessage = errorCode ? ERROR_MESSAGES[errorCode] ?? "Something went wrong." : null;

  return (
    <div
      style={{
        maxWidth: 480,
        margin: "3rem auto",
        padding: "2rem",
        borderRadius: 16,
        border: "1px solid #2a2f3a",
        background: "#161922",
        textAlign: "center",
      }}
    >
      {connected && !errorMessage ? (
        <>
          <div
            style={{
              width: 56,
              height: 56,
              margin: "0 auto 1.25rem",
              borderRadius: "50%",
              background: "rgba(34, 197, 94, 0.15)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "1.75rem",
            }}
            aria-hidden
          >
            ✓
          </div>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: "0 0 0.75rem" }}>
            {reconnected ? "Store reconnected" : "Store connected"}
          </h1>
          <p style={{ margin: 0, lineHeight: 1.6, opacity: 0.85 }}>
            Your Shopify store is linked to DevJewels. Our team will finish setup and
            sync your catalog — you can close this page.
          </p>
        </>
      ) : (
        <>
          <h1 style={{ fontSize: "1.35rem", fontWeight: 600, margin: "0 0 0.75rem" }}>
            Could not connect store
          </h1>
          <p style={{ margin: 0, lineHeight: 1.6, opacity: 0.85 }}>
            {errorMessage}
          </p>
        </>
      )}
      <p style={{ marginTop: "1.75rem", fontSize: "0.875rem", opacity: 0.55 }}>
        Questions?{" "}
        <Link href="mailto:support@devjewels.com" style={{ color: "#93c5fd" }}>
          Contact DevJewels
        </Link>
      </p>
    </div>
  );
}
