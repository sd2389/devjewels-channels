# DevJewels-Channels — App Store listing copy

Paste into Shopify Dev Dashboard → **DevJewels-Channels** → Distribution / App Store listing.

**Do not** paste Public Client ID/Secret into Channels vault until Shopify approves this listing (Buffed and Bubbly still uses Custom app `e421`).

## Company / business name (everywhere)
**Dev Jewels Inc.**

Use this exact string for Partner business name, business imprint, developer/org display, and any legal/company attribution on the listing. Product brand in marketing copy can still say “DevJewels”; the legal company is always **Dev Jewels Inc.**

---

## App name
Dev Jewels Inc. Channels

## Tagline / intro (short — keep under ~80 chars if the field is tight)
Sync approved DevJewels jewelry catalog and inventory to Shopify.

## Short description (≤ 100 characters if required)
Push DevJewels designs and live stock to Shopify for jewelers — products, inventory, and orders.

## App details (max 500 characters — paste exactly)

DevJewels Channels connects a jeweler’s Dev Jewels Inc. account to their store so approved designs and live inventory sync automatically.

It creates and updates products from entitled designs, keeps stock in sync with the chosen inventory location, and reads recent orders so catalog and fulfillment stay aligned.

For jewelers already using DevJewels (API access required). Install from Admin → Channels, pick customer and store domain, approve access, then choose a location to start sync.

**Privacy**
https://www.devjewels.com/customer/policy

**Support**
support@devjewels.com (or your Partner support email on file)

---

## App URL
https://channels.devjewels.com

## Allowed redirection URLs (must already be on released version)
- https://channels.devjewels.com/api/shopify/auth/callback
- http://localhost:3100/api/shopify/auth/callback

## Compliance webhooks (must be on released version)
URI: https://channels.devjewels.com/api/shopify/webhooks  
Topics: `customers/data_request`, `customers/redact`, `shop/redact`

## Protected customer data
Request access — do **not** select “This app doesn’t use customer data.”  
Reason: app reads order data (`read_orders`) to keep catalog/fulfillment aligned; may process customer contact fields Shopify exposes on orders for support/redaction compliance.

## Listing visibility after approval
Set to **Unlisted** so any merchant can install via Channels invite/Install, without App Store search discovery.

## App icon
Upload a square PNG ~1200×1200 (Shopify App Store guideline). Prefer the DevJewels logo mark on a solid brand background — do not stretch a rectangular footer logo.

## Screenshots (minimum — each file must be unique; Partners AI rejects duplicate MD5s)
1. `docs/app-store-assets/01-channels-connect.png` — Admin → Channels connect
2. `docs/app-store-assets/02-install-scopes.png` — Shopify install / scopes
3. `docs/app-store-assets/03-inventory-synced.png` — inventory synced (must differ from 02)
4. `docs/app-store-assets/feature-media.png` — feature media (must differ from screenshots)

## Sidekick
Do **not** ship template FAQ Sidekick tools (`list_faqs` / `get_faq`). Public app has no Sidekick `[sidekick]` summary; listing is catalog/inventory sync only.

---

## Submit checklist
1. `npx shopify app deploy --allow-updates --allow-deletes` from `devjewels-shopify-app/dev-jewels-channels` (GDPR webhooks on released version)
2. Icon + listing fields + privacy URL filled
3. Protected customer data requested
4. Automated checks green
5. Submit for review
6. After approval: Unlisted → paste Public Client ID + Secret into Channels (replaces Custom keys)
