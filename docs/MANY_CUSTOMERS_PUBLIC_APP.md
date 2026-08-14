# Many customers — Public Shopify app

Shopify **Custom** distribution cannot connect unrelated jewelers at scale (link-per-shop).  
For the product flow (API access → Install Shopify → live inventory), use **Public** distribution.

Distribution is **permanent** once chosen. If `DevJewels Channels` is already Custom, create a **new** Public app and paste its Client ID/Secret into the Channels dashboard.

## Customer experience (target)

1. Customer is a DevJewels customer with an **active API key**.
2. Staff approve their designs (same Customer API feed).
3. Staff (or customer) opens Channels → select customer → shop domain → **Install Shopify** → Approve.
4. Pick inventory location. Designs + stock sync automatically from API entitlements.
5. No Partners “Generate link” per customer.

## Partner / Dev Dashboard checklist (you)

### A. Create Public app (CLI preferred)

Partner app scaffold lives at:

`/Users/smitdesai/Coding/devjewels-shopify-app/dev-jewels-channels`

```bash
cd /Users/smitdesai/Coding/devjewels-shopify-app/dev-jewels-channels
npx shopify app deploy --allow-updates --allow-deletes
```

That repo owns `shopify.app.toml` only. OAuth/sync still run in **devjewels-channels**.

Manual path (if not using CLI):
1. [dev.shopify.com](https://dev.shopify.com) → **Dev Jewels Inc.** → **Create app**.
2. Choose **Public distribution** (not Custom). Distribution is permanent.
3. Name e.g. `DevJewels Channels`.
4. Scopes: `read_products`, `write_products`, `read_inventory`, `write_inventory`, `read_locations`, `read_orders`.
5. App URL: your Channels public URL (production) or `http://localhost:3100` for local.
6. Allowed redirection URL(s):
   - Local: `http://localhost:3100/api/shopify/auth/callback`
   - Production: `https://<your-channels-host>/api/shopify/auth/callback`
7. Enable **legacy install / authorization code** if the version UI offers it (Channels uses classic OAuth).
8. Release an active version.

**CLI-created app Client ID:** `4238185738d48848640cb7bf46362437` — paste with Client Secret into Channels dashboard.

### B. Mandatory compliance webhooks (required for App Store review)
In the app version / TOML / Partner webhook settings, point all three to:

`https://<your-channels-host>/api/shopify/webhooks`

Topics:
- `customers/data_request`
- `customers/redact`
- `shop/redact`

Channels handles these (HMAC with Client Secret; `shop/redact` deactivates the connection).  
**HTTPS required** for production — use a tunnel for local review testing if Shopify demands it.

See `shopify.app.toml.example` in this repo.

### C. Listing + review
1. Create App Store listing (name, description, privacy policy URL).
2. Submit for **app review**.
3. After approval, set listing to **unlisted** (not searchable) if you don’t want public discovery — Install from Channels still works.

### D. Wire Channels
1. Channels dashboard → paste **Client ID** + **Client Secret** → Save (once).
2. Set `CHANNELS_PUBLIC_BASE_URL` to the public HTTPS origin in production so redirects/webhooks match.

## Per customer (ops)

1. Active API key + approved designs.
2. Channels → select customer → `store.myshopify.com` → **Install Shopify**.
3. Merchant approves → pick location.

## Not allowed / don’t do

- New Custom app per customer (against Partner terms).
- Expecting Custom distribution to work like a multi-tenant SaaS without Public + review.
