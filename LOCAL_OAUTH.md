# Local Shopify OAuth

## Many customers (required)

Shopify **Custom distribution** = one store (or Plus multi-store under one org) + generate link per shop.  
**Not** OK for DevJewels connecting many unrelated jewelers.

**Public distribution** = many merchants. Install stays in Channels (customer + shop → Install Shopify).  
You can keep the App Store listing **unlisted** (not searchable); App Store **review** is still required.

Distribution is **locked after you choose it**. If this app is already **Custom**, create a **new** app with **Public** and paste the new Client ID/Secret into Channels (dashboard Save). Keep the Custom app only for one-off tests if needed.

Full checklist: [`docs/MANY_CUSTOMERS_PUBLIC_APP.md`](docs/MANY_CUSTOMERS_PUBLIC_APP.md)  
TOML example: [`shopify.app.toml.example`](shopify.app.toml.example)

Public app checklist (Shopify):
1. Dev Dashboard → **Create app** → **Public distribution** (do not pick Custom).
2. Scopes: products, inventory, locations, orders (same as Channels).
3. Redirect: `http://localhost:3100/api/shopify/auth/callback` (local) and your production/tunnel callback when live.
4. Compliance webhooks → `https://<host>/api/shopify/webhooks` (`customers/data_request`, `customers/redact`, `shop/redact`).
5. Complete listing + privacy policy + submit review; then unlisted if you want.
6. Channels dashboard → Save new Client ID + Secret once.

## Preferred: dashboard (no .env)

1. Open the Channels dashboard (`http://localhost:3100`).
2. Paste Shopify Partner **Client ID** and **Client Secret** once → **Save**.
3. Select customer + `your-store.myshopify.com` → **Install Shopify** → approve → pick location.

Credentials live in the vault (`.data/secrets/`, gitignored). Restart is **not** required after saving in the UI.

Partner app **Allowed redirection URL(s)** must be:

`http://localhost:3100/api/shopify/auth/callback`

(or `{CHANNELS_PUBLIC_BASE_URL}/api/shopify/auth/callback` if you set a public/tunnel URL).

## Optional env fallback

If dashboard credentials are not saved, Channels can use repo-root `.env`:

```bash
SHOPIFY_API_KEY=          # optional fallback
SHOPIFY_API_SECRET=       # optional fallback
CHANNELS_PUBLIC_BASE_URL=http://localhost:3100
```

`SHOPIFY_OAUTH_REDIRECT_URI` is optional. Default is  
`http://localhost:3100/api/shopify/auth/callback`.

Next loads **repo-root** `.env` (via `apps/core/next.config.ts`), not `apps/core/.env`.  
Env fallback needs a process restart; vault does not.

## Without Partner OAuth keys

Use **Advanced: paste Admin API token**. That path does not need Client ID/Secret.

## Verify

```bash
npm run selfcheck:oauth -w @devjewels-channels/shopify
npm run selfcheck:vault -w @devjewels-channels/core
```

Install without vault or env keys should show:  
“Save Partner Client ID and Secret once in the dashboard (Shopify app settings).” — not a raw JSON page.
