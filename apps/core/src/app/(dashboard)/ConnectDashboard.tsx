"use client";

import { FormEvent, useCallback, useEffect, useState, type CSSProperties } from "react";

type LocationRow = {
  connection_id: string;
  external_location_id: string;
  name: string | null;
  is_primary: boolean;
};

type ConnectionSummary = {
  id: string;
  name: string;
  platform: string;
  is_active: boolean;
  customer_id?: number | null;
  markup_mode?: string;
  markup_value?: number;
  sync_inventory: boolean;
  sync_products?: boolean;
  shop_domain: string | null;
  locations: LocationRow[];
  primary_location_id: string | null;
};

type ImportResult = {
  importId: string;
  status: string;
  processed: number;
  failed: number;
  skipped: number;
  totalDesigns: number;
};

type OauthConfigStatus = {
  configured: boolean;
  apiKeyLast4: string | null;
};

function humanError(err: unknown): string {
  const raw = err instanceof Error ? err.message : "Request failed";
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return "Something went wrong. Try again.";
  }
  return trimmed;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const err =
      data &&
      typeof data === "object" &&
      "error" in data &&
      typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error.trim()
        : "";
    throw new Error(err || `Request failed (${res.status})`);
  }
  return data as T;
}

const fieldStyle: CSSProperties = {
  display: "block",
  width: "100%",
  boxSizing: "border-box",
  padding: "0.65rem 0.75rem",
  borderRadius: 6,
  border: "1px solid #3a4150",
  background: "#0f1115",
  color: "#e8eaed",
  fontSize: "1rem",
  minHeight: 44,
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: "0.875rem",
  marginBottom: "0.35rem",
  opacity: 0.9,
};

const btnPrimary: CSSProperties = {
  minHeight: 44,
  padding: "0.6rem 1.1rem",
  borderRadius: 6,
  border: "none",
  background: "#c9a227",
  color: "#12141a",
  fontWeight: 600,
  cursor: "pointer",
  fontSize: "0.95rem",
};

const btnSecondary: CSSProperties = {
  ...btnPrimary,
  background: "#2a2f3a",
  color: "#e8eaed",
};

const cardStyle: CSSProperties = {
  border: "1px solid #2a2f3a",
  borderRadius: 8,
  padding: "1.25rem",
  background: "#161a22",
  marginBottom: "1rem",
};

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  missing_oauth_params: "Shopify install was cancelled or incomplete.",
  invalid_hmac: "Shopify install failed security check. Try again.",
  invalid_state: "Install session expired. Click Install Shopify again.",
  oauth_not_configured:
    "Save Partner Client ID and Secret once in the dashboard (Shopify app settings).",
  missing_customer: "Select a DevJewels customer_id before Install Shopify.",
  connect_failed: "Could not finish Shopify install. Try again or use token paste.",
};

/**
 * Staff connect wizard:
 * 0) Operator: save Partner Client ID + Secret once (vault)
 * 1) Install Shopify (OAuth) → approve → pick location
 * 2) Optional: paste Admin API token (Advanced)
 * 3) Import catalog
 */
export function ConnectDashboard() {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [oauthConfigured, setOauthConfigured] = useState<boolean | null>(null);
  const [apiKeyLast4, setApiKeyLast4] = useState<string | null>(null);
  const [showUpdateCreds, setShowUpdateCreds] = useState(false);
  const [partnerApiKey, setPartnerApiKey] = useState("");
  const [partnerApiSecret, setPartnerApiSecret] = useState("");
  const [oauthShop, setOauthShop] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [markupMode, setMarkupMode] = useState<"none" | "percent" | "multiplier">(
    "none",
  );
  const [markupValue, setMarkupValue] = useState("0");
  const [shopDomain, setShopDomain] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showTokenPaste, setShowTokenPaste] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [locationId, setLocationId] = useState("");
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  const refreshOauthConfig = useCallback(async () => {
    const data = await api<OauthConfigStatus>("/api/admin/shopify-oauth-config");
    setOauthConfigured(data.configured);
    setApiKeyLast4(data.apiKeyLast4);
    if (data.configured) {
      setPartnerApiKey("");
      setPartnerApiSecret("");
      setShowUpdateCreds(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    const data = await api<{ connections: ConnectionSummary[] }>(
      "/api/admin/connections",
    );
    setConnections(data.connections);
    if (data.connections.length > 0 && !selectedId) {
      const first = data.connections[0]!;
      setSelectedId(first.id);
      setLocationId(
        first.primary_location_id ||
          first.locations[0]?.external_location_id ||
          "",
      );
    }
  }, [selectedId]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const shopifyError = params.get("shopify_error");
    const reconnected = params.get("reconnected") === "1";
    if (connected) {
      setSelectedId(connected);
      setStatus(
        reconnected
          ? "Shopify store reconnected — credentials updated. Pick a location if needed."
          : "Shopify store connected. Pick an inventory location, then import designs.",
      );
      window.history.replaceState({}, "", "/");
    } else if (shopifyError) {
      setError(
        OAUTH_ERROR_MESSAGES[shopifyError] ||
          "Shopify install failed. Try again.",
      );
      window.history.replaceState({}, "", "/");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await Promise.all([refresh(), refreshOauthConfig()]);
      } catch (err) {
        if (!cancelled) {
          setError(humanError(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh, refreshOauthConfig]);

  const selected = connections.find((c) => c.id === selectedId) ?? null;

  async function onSaveOauthApp(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const data = await api<OauthConfigStatus>("/api/admin/shopify-oauth-config", {
        method: "POST",
        body: JSON.stringify({
          apiKey: partnerApiKey,
          apiSecret: partnerApiSecret,
        }),
      });
      setOauthConfigured(data.configured);
      setApiKeyLast4(data.apiKeyLast4);
      setPartnerApiKey("");
      setPartnerApiSecret("");
      setShowUpdateCreds(false);
      setStatus("Shopify app connected — Install stores below.");
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  }

  async function onInstall(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus(null);
    const shop = oauthShop.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
    const cid = Number(customerId);
    if (!shop) {
      setError("Enter your shop domain (your-store.myshopify.com)");
      return;
    }
    if (!Number.isInteger(cid) || cid <= 0) {
      setError("Enter DevJewels customer_id (Customer.pk). Customer must have an active API key.");
      return;
    }
    const startUrl = `/api/shopify/auth?shop=${encodeURIComponent(shop)}&customer_id=${encodeURIComponent(String(cid))}`;
    try {
      setBusy(true);
      const res = await fetch(startUrl, { redirect: "manual" });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("Location");
        if (location) {
          window.location.href = location;
          return;
        }
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as unknown;
        const msg =
          body &&
          typeof body === "object" &&
          "error" in body &&
          typeof (body as { error: unknown }).error === "string"
            ? (body as { error: string }).error.trim()
            : "";
        setError(
          msg ||
            OAUTH_ERROR_MESSAGES.oauth_not_configured ||
            "Shopify OAuth start failed",
        );
        if (res.status === 503) {
          setOauthConfigured(false);
          setShowUpdateCreds(true);
        }
        return;
      }
      window.location.href = startUrl;
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  }

  async function onConnect(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setStatus(null);
    setImportResult(null);
    try {
      const cid = Number(customerId);
      if (!Number.isInteger(cid) || cid <= 0) {
        throw new Error("customer_id is required");
      }
      const data = await api<{
        connection: { id: string };
        locations: LocationRow[];
        reconnected?: boolean;
      }>("/api/admin/connections/shopify", {
        method: "POST",
        body: JSON.stringify({
          shopDomain,
          accessToken,
          name: displayName || undefined,
          customerId: cid,
          markupMode,
          markupValue: Number(markupValue) || 0,
        }),
      });
      setAccessToken("");
      setShopDomain("");
      setDisplayName("");
      setSelectedId(data.connection.id);
      setLocationId(
        data.locations.find((l) => l.is_primary)?.external_location_id ||
          data.locations[0]?.external_location_id ||
          "",
      );
      setStatus(
        data.reconnected
          ? "Store credentials updated (reconnected)."
          : "Store connected via Admin API token.",
      );
      await refresh();
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSaveLocation() {
    if (!selectedId || !locationId) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/connections/${selectedId}`, {
        method: "POST",
        body: JSON.stringify({
          action: "set_location",
          externalLocationId: locationId,
        }),
      });
      setStatus("Primary inventory location saved.");
      await refresh();
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  }

  async function onImport() {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    setImportResult(null);
    try {
      const data = await api<{ import: ImportResult }>(
        `/api/admin/connections/${selectedId}`,
        {
          method: "POST",
          body: JSON.stringify({ action: "import_catalog", maxDesigns: 50 }),
        },
      );
      setImportResult(data.import);
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p style={{ opacity: 0.75 }}>Loading connections…</p>;
  }

  return (
    <div>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.35rem", textWrap: "balance" }}>
        Connect Shopify
      </h1>
      <p style={{ opacity: 0.8, lineHeight: 1.5, marginBottom: "1.25rem", maxWidth: "65ch" }}>
        Bind one Shopify shop to one DevJewels customer. Save Partner app credentials once,
        then Install Shopify per store.
      </p>

      {error ? (
        <div
          role="alert"
          style={{
            ...cardStyle,
            borderColor: "#8b3a3a",
            background: "#2a1717",
            color: "#f0c0c0",
          }}
        >
          {error}
        </div>
      ) : null}

      {status ? (
        <div
          role="status"
          style={{
            ...cardStyle,
            borderColor: "#3a5a3a",
            background: "#172217",
            color: "#c0f0c0",
          }}
        >
          {status}
        </div>
      ) : null}

      {oauthConfigured ? (
        <section style={cardStyle} aria-labelledby="app-connected-heading">
          <h2 id="app-connected-heading" style={{ fontSize: "1.05rem", margin: "0 0 0.5rem" }}>
            Shopify app connected
          </h2>
          <p style={{ margin: "0 0 0.5rem", opacity: 0.85, lineHeight: 1.45 }}>
            Install stores below.
            {apiKeyLast4 ? ` Client ID ending in ${apiKeyLast4}.` : ""}
          </p>
          <button
            type="button"
            onClick={() => setShowUpdateCreds((v) => !v)}
            style={{
              background: "none",
              border: "none",
              color: "#e8eaed",
              font: "inherit",
              cursor: "pointer",
              padding: 0,
              minHeight: 44,
              textAlign: "left",
              opacity: 0.75,
            }}
            aria-expanded={showUpdateCreds}
          >
            {showUpdateCreds ? "▾" : "▸"} Update app credentials
          </button>
          {showUpdateCreds ? (
            <form onSubmit={onSaveOauthApp} style={{ display: "grid", gap: "0.85rem", marginTop: "0.75rem" }}>
              <div>
                <label htmlFor="partner-api-key" style={labelStyle}>
                  Client ID
                </label>
                <input
                  id="partner-api-key"
                  name="apiKey"
                  autoComplete="off"
                  value={partnerApiKey}
                  onChange={(e) => setPartnerApiKey(e.target.value)}
                  style={fieldStyle}
                  required
                />
              </div>
              <div>
                <label htmlFor="partner-api-secret" style={labelStyle}>
                  Client Secret
                </label>
                <input
                  id="partner-api-secret"
                  name="apiSecret"
                  type="password"
                  autoComplete="off"
                  value={partnerApiSecret}
                  onChange={(e) => setPartnerApiSecret(e.target.value)}
                  style={fieldStyle}
                  required
                />
              </div>
              <button type="submit" disabled={busy} style={btnPrimary}>
                {busy ? "Saving…" : "Save"}
              </button>
            </form>
          ) : null}
        </section>
      ) : (
        <section style={cardStyle} aria-labelledby="partner-app-heading">
          <h2 id="partner-app-heading" style={{ fontSize: "1.05rem", margin: "0 0 0.5rem" }}>
            Shopify Partner app (one-time)
          </h2>
          <p style={{ margin: "0 0 1rem", opacity: 0.8, lineHeight: 1.45 }}>
            Paste Client ID and Secret from Shopify Partners. Saved in this dashboard — no
            .env edits after this.
          </p>
          <form onSubmit={onSaveOauthApp} style={{ display: "grid", gap: "0.85rem" }}>
            <div>
              <label htmlFor="partner-api-key" style={labelStyle}>
                Client ID
              </label>
              <input
                id="partner-api-key"
                name="apiKey"
                autoComplete="off"
                placeholder="Shopify Partner Client ID"
                value={partnerApiKey}
                onChange={(e) => setPartnerApiKey(e.target.value)}
                style={fieldStyle}
                required
              />
            </div>
            <div>
              <label htmlFor="partner-api-secret" style={labelStyle}>
                Client Secret
              </label>
              <input
                id="partner-api-secret"
                name="apiSecret"
                type="password"
                autoComplete="off"
                placeholder="Shopify Partner Client Secret"
                value={partnerApiSecret}
                onChange={(e) => setPartnerApiSecret(e.target.value)}
                style={fieldStyle}
                required
              />
            </div>
            <button type="submit" disabled={busy} style={btnPrimary}>
              {busy ? "Saving…" : "Save"}
            </button>
          </form>
        </section>
      )}

      <section style={cardStyle} aria-labelledby="install-heading">
        <h2 id="install-heading" style={{ fontSize: "1.05rem", margin: "0 0 1rem" }}>
          Install Shopify
        </h2>
        <form onSubmit={onInstall} style={{ display: "grid", gap: "0.85rem" }}>
          <div>
            <label htmlFor="customer-id" style={labelStyle}>
              DevJewels customer_id
            </label>
            <input
              id="customer-id"
              name="customerId"
              inputMode="numeric"
              autoComplete="off"
              placeholder="e.g. 42"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              style={fieldStyle}
              required
            />
          </div>
          <div>
            <label htmlFor="oauth-shop" style={labelStyle}>
              Shop domain
            </label>
            <input
              id="oauth-shop"
              name="shop"
              autoComplete="off"
              placeholder="your-store.myshopify.com"
              value={oauthShop}
              onChange={(e) => setOauthShop(e.target.value)}
              style={fieldStyle}
              required
            />
          </div>
          <button type="submit" disabled={busy} style={btnPrimary}>
            {busy ? "Starting…" : "Install Shopify"}
          </button>
        </form>
        <p style={{ fontSize: "0.8rem", opacity: 0.65, marginTop: "0.85rem", lineHeight: 1.45 }}>
          Approve in Shopify, then pick an inventory location. Re-installing the same shop for
          the same customer updates credentials.
        </p>
      </section>

      <section style={cardStyle} aria-labelledby="fallback-heading">
        <h2 id="fallback-heading" style={{ fontSize: "1.05rem", margin: "0 0 0.75rem" }}>
          <button
            type="button"
            onClick={() => setShowTokenPaste((v) => !v)}
            style={{
              background: "none",
              border: "none",
              color: "#e8eaed",
              font: "inherit",
              fontWeight: 600,
              cursor: "pointer",
              padding: 0,
              minHeight: 44,
              textAlign: "left",
            }}
            aria-expanded={showTokenPaste}
          >
            {showTokenPaste ? "▾" : "▸"} Advanced: paste Admin API token
          </button>
        </h2>
        {showTokenPaste ? (
          <>
            <p style={{ fontSize: "0.85rem", opacity: 0.7, margin: "0 0 1rem", lineHeight: 1.45 }}>
              Fallback if you already have an Admin API token. Prefer Install Shopify above.
            </p>
            <form onSubmit={onConnect} style={{ display: "grid", gap: "0.85rem" }}>
              <div>
                <label htmlFor="shop-domain" style={labelStyle}>
                  Shop domain
                </label>
                <input
                  id="shop-domain"
                  name="shopDomain"
                  autoComplete="off"
                  placeholder="your-store.myshopify.com"
                  value={shopDomain}
                  onChange={(e) => setShopDomain(e.target.value)}
                  style={fieldStyle}
                  required
                />
              </div>
              <div>
                <label htmlFor="access-token" style={labelStyle}>
                  Admin API access token
                </label>
                <input
                  id="access-token"
                  name="accessToken"
                  type="password"
                  autoComplete="off"
                  placeholder="shpat_…"
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  style={fieldStyle}
                  required
                />
              </div>
              <div>
                <label htmlFor="display-name" style={labelStyle}>
                  Display name (optional)
                </label>
                <input
                  id="display-name"
                  name="name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  style={fieldStyle}
                />
              </div>
              <div>
                <label htmlFor="token-customer-id" style={labelStyle}>
                  DevJewels customer_id
                </label>
                <input
                  id="token-customer-id"
                  name="customerId"
                  inputMode="numeric"
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  style={fieldStyle}
                  required
                />
              </div>
              <div>
                <label htmlFor="markup-mode" style={labelStyle}>
                  Price markup
                </label>
                <select
                  id="markup-mode"
                  value={markupMode}
                  onChange={(e) =>
                    setMarkupMode(e.target.value as "none" | "percent" | "multiplier")
                  }
                  style={fieldStyle}
                >
                  <option value="none">None (push API price)</option>
                  <option value="percent">Percent (+%)</option>
                  <option value="multiplier">Multiplier (×)</option>
                </select>
              </div>
              {markupMode !== "none" ? (
                <div>
                  <label htmlFor="markup-value" style={labelStyle}>
                    Markup value
                  </label>
                  <input
                    id="markup-value"
                    name="markupValue"
                    inputMode="decimal"
                    value={markupValue}
                    onChange={(e) => setMarkupValue(e.target.value)}
                    style={fieldStyle}
                  />
                </div>
              ) : null}
              <button type="submit" disabled={busy} style={btnSecondary}>
                {busy ? "Connecting…" : "Connect with token"}
              </button>
            </form>
          </>
        ) : null}
      </section>

      {connections.length > 0 ? (
        <section style={cardStyle} aria-labelledby="manage-heading">
          <h2 id="manage-heading" style={{ fontSize: "1.05rem", margin: "0 0 1rem" }}>
            2. Location &amp; import
          </h2>

          <div style={{ marginBottom: "1rem" }}>
            <label htmlFor="connection" style={labelStyle}>
              Connected store
            </label>
            <select
              id="connection"
              value={selectedId || ""}
              onChange={(e) => {
                const id = e.target.value;
                setSelectedId(id);
                const row = connections.find((c) => c.id === id);
                setLocationId(
                  row?.primary_location_id ||
                    row?.locations[0]?.external_location_id ||
                    "",
                );
                setImportResult(null);
              }}
              style={fieldStyle}
            >
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.customer_id != null ? ` · customer ${c.customer_id}` : ""}
                  {c.shop_domain ? ` (${c.shop_domain})` : ""}
                  {c.sync_inventory ? " · inventory on" : ""}
                  {c.sync_products ? " · catalog on" : ""}
                </option>
              ))}
            </select>
          </div>

          {selected ? (
            <>
              <div style={{ marginBottom: "1rem" }}>
                <label htmlFor="location" style={labelStyle}>
                  Inventory location
                </label>
                <select
                  id="location"
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                  style={fieldStyle}
                >
                  {selected.locations.map((loc) => (
                    <option
                      key={loc.external_location_id}
                      value={loc.external_location_id}
                    >
                      {loc.name || loc.external_location_id}
                      {loc.is_primary ? " (primary)" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
                <button
                  type="button"
                  disabled={busy || !locationId}
                  onClick={onSaveLocation}
                  style={btnSecondary}
                >
                  Save location
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={onImport}
                  style={btnPrimary}
                >
                  {busy ? "Working…" : "Import designs (up to 50)"}
                </button>
              </div>
            </>
          ) : null}

          {importResult ? (
            <p
              role="status"
              style={{ marginTop: "1rem", opacity: 0.9, lineHeight: 1.5 }}
            >
              Import {importResult.status}: {importResult.processed} processed,{" "}
              {importResult.failed} failed, {importResult.skipped} skipped of{" "}
              {importResult.totalDesigns}.
            </p>
          ) : null}
        </section>
      ) : (
        <p style={{ opacity: 0.7 }}>No stores connected yet — use Install Shopify above.</p>
      )}
    </div>
  );
}
