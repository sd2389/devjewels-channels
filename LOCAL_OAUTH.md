# Local Shopify OAuth

## Preferred: dashboard (no .env)

1. Open the Channels dashboard (`http://localhost:3100`).
2. Paste Shopify Partner **Client ID** and **Client Secret** once → **Save**.
3. Enter `customer_id` + `your-store.myshopify.com` → **Install Shopify** → approve → pick location.

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
