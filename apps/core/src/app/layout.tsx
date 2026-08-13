import type { ReactNode } from "react";

export const metadata = {
  title: "DevJewels Channels",
  description: "Multi-platform commerce sync dashboard",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
          background: "#0f1115",
          color: "#e8eaed",
          minHeight: "100vh",
        }}
      >
        <header
          style={{
            borderBottom: "1px solid #2a2f3a",
            padding: "1rem 1.5rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <strong style={{ letterSpacing: "0.02em" }}>DevJewels Channels</strong>
          <span style={{ opacity: 0.65, fontSize: "0.875rem" }}>
            Shopify connect · inventory sync
          </span>
        </header>
        <main style={{ padding: "1.5rem", maxWidth: 960, margin: "0 auto" }}>
          {children}
        </main>
      </body>
    </html>
  );
}
