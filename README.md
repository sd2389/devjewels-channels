# DevJewels Channels

Private sibling SST monorepo for multi-platform commerce sync (Shopify first; WooCommerce later).  
Dev Jewels core (Django/FastAPI) stays the system of record. Channels never queries `public` tables.

**Secrets:** copy `.env.example` → `.env` locally. Never commit `.env`, vault files under `.data/`, or Partner/API tokens. Prefer dashboard vault for Shopify Client ID/Secret (see [LOCAL_OAUTH.md](./LOCAL_OAUTH.md)).

## Workspace layout

```text
devjewels-channels/
  sst.config.ts          # Next.js site + shared SQS queues (+ DLQs)
  apps/
    core/                # kernel: types, AdapterRouter, shared DB, workers, dashboard, ingest API
    shopify/             # platform app: adapter + shopify_* migrations + OAuth/webhook helpers
    woocommerce/         # platform stub: notImplemented adapter + woocommerce_* migration note
```

**Rules**
- Platform apps depend on `apps/core` contracts (`CommerceChannel`); they do not import each other.
- Shared queues live in core/SST; platforms only supply adapters + prefixed tables + webhook/OAuth logic.
- Adding WooCommerce later = implement `apps/woocommerce` + register adapter — no Django rewrite.

## Postgres: same database, schema `channels`

**MVP hard rule:** Channels uses the **same Postgres database name** as DevJewels (`DB_NAME`, e.g. local `devjewels` — same host/port/name as `devjewels-backend/.env.example`). Isolation is **schema `channels` only**.

- Do **not** create a new RDS instance for Channels (MVP).
- Do **not** `CREATE DATABASE` a separate Channels database (MVP).
- Shared tables and `shopify_*` / `woocommerce_*` tables all live in schema `channels`.

| Kind | Tables | Owner |
|------|--------|--------|
| Shared | `connection`, `product_mapping`, `variant_mapping`, `sync_log`, `webhook_event`, `catalog_import`, `ingest_event` | `apps/core` migrations |
| Shopify | `shopify_oauth_state`, `shopify_location`, `shopify_webhook_subscription`, `shopify_rate_limit_state` | `apps/shopify` |
| WooCommerce | `woocommerce_*` (placeholder) | `apps/woocommerce` |

**Variant identity:** `variant_mapping` is keyed by `design_no` + `job_no` (Dev Jewels sellable unit), not a fictional Django Variant model.

### Connection (env)

Align with backend `DB_HOST` / `DB_PORT` / `DB_NAME`. App role is `channels_app` (not `devjewels_user`).

```text
DATABASE_URL=postgresql://channels_app:***@127.0.0.1:5432/devjewels?options=-csearch_path%3Dchannels
CHANNELS_SCHEMA=channels
```

See `.env.example` for `DB_*` mirrors + comments.

### Role `channels_app` (hard rule)

- Dedicated DB role: `CONNECT` on the **shared** DevJewels database; grants **only** on schema `channels`.
- **No** `USAGE`/`SELECT`/`JOIN` on `public`, `diamond`, or `b2c` (role grants + app SQL guard).
- Catalog, inventory, price, and order reserve go through Django `channels_api` HTTP only (`DEVJEWELS_API_BASE_URL`).

SQL stubs:
- `apps/core/src/db/shared/000_role_grants.example.sql` — role + grants (ops)
- `apps/core/src/db/shared/001_channels_schema.sql` — `CREATE SCHEMA` + shared tables
- `apps/core/src/db/shared/002_connection_entitlements.sql` — customer_id + markup columns
- `apps/core/src/db/shared/003_connection_design_markup.sql` — per-design markup overrides
- `apps/shopify/src/db/001_shopify_tables.sql`
- `apps/woocommerce/src/db/001_woocommerce_tables.sql`

## What the sync owns (hard rule)

A connected store is the merchant's. DevJewels owns live stock; everything a
shopper reads is theirs. `connection.sync_product_content` decides which, and it
is **FALSE for every shop by default**.

| | `sync_product_content = false` (default) | `= true` (opt in) |
|---|---|---|
| Product title, description, tags, product type | never written | written from the design |
| Selling price of a variant already on the product | never written | written (cost + markup) |
| Images / media | never written | replaced from the design |
| Product status (active / draft) | never written | never written |
| Product options the merchant made | left alone | one `Metal` option enforced |
| **Which pieces exist (variants)** | **reconciled from live stock** | reconciled from live stock |
| **Quantity per piece** | **written** | written |
| **Wholesale unit cost** (`inventoryItem.cost`) | **written** | written |

A design holds many pieces (`job_no`). A piece that sells leaves the feed, and
its Shopify variant is deleted on the next sync — a storefront must never outlive
the stock. A new piece is added as a variant and inherits the merchant's own
price for that design, so it never lands at 0.00. Only pieces Channels mapped are
ever removed: a variant the merchant added themselves is never touched, and
Shopify needs one variant, so the last survivor is zeroed instead of deleted.

Where the rule lives:

- `apps/shopify/src/products.ts` — `updateShopifyProduct` routes to
  `syncShopifyLiveStockVariants` unless `syncProductContent === true`. The guard
  is at the adapter, not the call site, so a new caller cannot reopen the hole.
  `createShopifyProduct` reclaim (an unmapped design that already exists in
  Shopify) inherits the same flag.
- `apps/core/src/services/productSyncService.ts` — revoke zeroes every mapped
  piece instead of deleting the product, and keeps mappings so re-entitlement
  restores stock. Only `sync_product_content = true` deletes.
- `apps/shopify/src/merchantOwnedCatalog.selfcheck.ts` — asserts that no
  merchant-owned mutation (`productUpdate`, `productCreateMedia`,
  `productOption*`, `productDelete`) is ever sent with content sync off. Runs in
  CI via `npm run selfcheck`.

To hand a shop's catalog copy back to DevJewels:

```sql
UPDATE channels.connection SET sync_product_content = TRUE WHERE id = '<uuid>';
```

### Piece details on the storefront

Every piece carries its stock-table row as variant metafields in namespace
`devjewels`: `job_no` `design_no` `metal` `purity` `color` `diamond_type`
`dia_qly` `dia_clr` `gwt` `nwt` `dwt` `swt` `size` `store` `category`
`certificate`.

The list lives in `apps/shopify/src/variantMetafieldSchema.ts` and feeds both
writers, so values and definitions cannot drift apart:

- `variantMetafields` writes the values — on add **and** on every later sync, so
  a certificate added or a size corrected upstream reaches the storefront.
- `ensureShopifyVariantMetafieldDefinitions` declares them to Shopify with
  `access: { admin: MERCHANT_READ, storefront: PUBLIC_READ }`. Without a
  definition the values are stored but not reliably readable from Liquid or the
  Storefront API, which is why the details were invisible before.

Definitions are created at connect and re-asserted at catalog import, so a shop
connected earlier heals on its next import. Creating one that already exists is
a no-op; the storefront access is re-applied in case it was off. The whole step
is best effort — it is logged as `shopify_metafield_definitions_ensured` and
never fails a connect or an import. `write_products` already covers it, so no
merchant re-authorization is needed.

A theme reads them per variant:

```liquid
{{ variant.metafields.devjewels.dia_qly }}
{{ variant.metafields.devjewels.certificate }}
```

A detail the job does not carry is omitted rather than written blank (Shopify
rejects an empty text field), so a value that becomes empty upstream keeps its
last known value until it is cleared in Shopify.

## Queues (SST)

Owned by core, shared across platforms:

| Queue | DLQ | Purpose |
|-------|-----|---------|
| `InventorySync` | `InventorySyncDlq` | Fan-out inventory updates per connection |
| `OrderProcessing` | `OrderProcessingDlq` | Webhook → normalize → Django reserve |
| `ProductSync` | `ProductSyncDlq` | Catalog / product create-update |
| `PriceSync` | `PriceSyncDlq` | Reserved (price.updated fans out to ProductSync) |

Wired in `sst.config.ts`. Workers:
- `InventorySync` → `apps/core/src/workers/inventorySync.handler`
- `ProductSync` → `apps/core/src/workers/productSync.handler`

## Install / run

Requires Node ≥ 20.

```bash
cd /Users/smitdesai/Coding/devjewels-channels
cp .env.example .env         # fill CHANNELS_SERVICE_TOKEN, DATABASE_URL; Shopify keys optional (dashboard save preferred)
npm install                  # npm workspaces (pnpm: pnpm install with pnpm-workspace.yaml)

# Local dashboard + API routes (no AWS)
npm run dev                  # http://localhost:3100

# Typecheck all workspaces
npm run typecheck

# SST (needs AWS credentials / stage)
npm run sst:dev
```

## AWS deploy (SST + GitHub OIDC + Infisical)

Channels deploys as **API Gateway HTTP API + Lambda + SQS** (no CloudFront / no Next on AWS).

- Workflow: [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) — same OIDC pattern as `devjewels-backend`
- Secrets: dedicated Infisical project (path `/`, production) — see [docs/AWS_DEPLOY.md](./docs/AWS_DEPLOY.md)
- Django: `CHANNELS_BASE_URL=<api-url>` → posts to `/api/internal/events`
- Local UI only: `npm run dev` (Next dashboard). Production connect/OAuth uses HTTP APIs + `CHANNELS_OAUTH_SUCCESS_URL`.

```bash
git checkout -b feat/sst-aws-deploy-oidc
npm run sst:deploy -- --stage production
```


Useful paths once running:
- Dashboard shell: `GET /`
- Event ingest: `POST /api/internal/events` (Bearer `CHANNELS_SERVICE_TOKEN`) — zod envelope, idempotent `event_id`, inventory fan-out → SQS or in-memory
- Selfcheck: `npm run selfcheck:events -w @devjewels-channels/core`
- Inventory selfcheck (mocked Shopify): `npm run selfcheck:inventory -w @devjewels-channels/core`
- Shopify OAuth: `GET /api/shopify/auth?shop=store.myshopify.com` → Shopify authorize → callback persists offline token + registers order webhooks
- Shopify webhooks: `POST /api/shopify/webhooks` (HMAC verified)
- Woo webhooks stub: `POST /api/woocommerce/webhooks` → 501
- OAuth selfcheck: `npm run selfcheck:oauth -w @devjewels-channels/shopify`

## Shopify OAuth (operator one-time)

Local setup: see **[LOCAL_OAUTH.md](./LOCAL_OAUTH.md)**.

1. Create a Shopify Partner app (Custom / public app for your org).
2. Set **Allowed redirection URL(s)** to  
   `http://localhost:3100/api/shopify/auth/callback`  
   (or `{CHANNELS_PUBLIC_BASE_URL}/api/shopify/auth/callback` behind a tunnel).
3. **Once in the Channels dashboard:** paste Partner Client ID + Secret → Save.  
   Do not put these in `.env` unless you want an optional fallback. Vault wins if both are set. No restart after dashboard save.
4. Staff/customer per store: enter `customer_id` + `store.myshopify.com` → **Install Shopify** → approve → pick location.

Token paste remains under **Advanced**. Re-install updates the same connection credentials (no duplicate).

## Auth (MVP)

| Direction | Mechanism |
|-----------|-----------|
| Django → Channels | `Authorization: Bearer $CHANNELS_SERVICE_TOKEN` on `/api/internal/events` |
| Channels → Django | Same token on `/api/v1/internal/channels/*` (backend `channels_api`) |

## Event ingest → Shopify (inventory + catalog)

1. **Django publisher** — `ChannelsEventPublisher` POSTs events (gated by `feature_channels`):
   - `inventory.updated` after global stock sync diffs
   - `catalog.updated` on Design create/update (catalog-relevant fields via `post_save` + `on_commit`)
   - `price.updated` (when published) fans out to the same product-sync path
2. **Ingest** — validates envelope (zod), claims `event_id` via `channels.ingest_event` (shared DB) or memory fallback, fan-out enqueue.
3. **Inventory fan-out** — loads active `variant_mapping` rows for `design_no` + `job_no`; enqueues inventory-sync jobs. When **unmapped**, enqueues **product.sync** (create path) for connections with `sync_products=TRUE`.
4. **Catalog fan-out** — active connections with `sync_products=TRUE` → one `product.sync` job per connection (bounded).
5. **Workers**
   - Inventory → Shopify `inventorySetQuantities`
   - Product → pull Django facade → **create** if no `product_mapping`, else **update** (`productUpdate` + variant bulk update/create)
6. **Connection flags** — `sync_inventory`, `sync_products` (catalog create/update, default ON), `sync_price`, `sync_orders` (ON when the Customer API key has `can_place_orders` — Shopify `orders/create` then auto-creates a pending DevJewels order via `orders/reserve`).
7. **Live inventory + auto orders plan** — see backend `docs/CHANNELS_LIVE_INVENTORY_AND_ORDERS.md`. Website sales publish `inventory.updated` qty 0 immediately; e2e: `npm run selfcheck:shopify-live-e2e` in `apps/core`.
7. **Secrets** — `connection.credentials_secret_ref` is `env:VAR`, `sm:ID`, or `vault:<id>` (payload in `channels.vault_secret` or local files). Never log secret values.

### What auto-syncs now

| Change in DevJewels | Shopify effect |
|---------------------|----------------|
| Design create/update (title, price fields, taxonomy, active/archive, …) | Mapped product updated; unmapped design created when it has live jobs |
| New design + first live stock job | Product created (via unmapped inventory → product.sync) |
| Stock qty change on mapped job | Inventory quantity updated |
| Manual connect / catalog import | Create or **update** existing mappings (safe re-import) |

### Seed a local test connection

```bash
# Apply migrations (same DB as DevJewels)
psql "$DATABASE_URL" -f apps/core/src/db/shared/001_channels_schema.sql
psql "$DATABASE_URL" -f apps/core/src/db/shared/002_connection_entitlements.sql
psql "$DATABASE_URL" -f apps/core/src/db/shared/003_connection_design_markup.sql
psql "$DATABASE_URL" -f apps/core/src/db/shared/004_vault_secret.sql
psql "$DATABASE_URL" -f apps/shopify/src/db/001_shopify_tables.sql
psql "$DATABASE_URL" -f apps/shopify/src/db/004_shopify_connect_invite.sql
psql "$DATABASE_URL" -f apps/shopify/src/db/005_shopify_connect_invite_shop_pending.sql

# Credentials in env (not SQL)
export CHANNELS_SECRET_shopify_local='{"accessToken":"shpat_xxx","shopDomain":"your-store.myshopify.com"}'

# Seed connection + shopify_location + variant_mapping (edit GIDs / design_no / job_no first)
psql "$DATABASE_URL" -f apps/shopify/src/db/002_seed_local_shopify_example.sql
```

Then POST `/api/internal/events` with `inventory.updated` for that `design_no`/`job_no`, or run the worker selfcheck (mocked HTTP, no Shopify):

```bash
npm run selfcheck:inventory -w @devjewels-channels/core
npm run selfcheck:inventory -w @devjewels-channels/shopify
npm run selfcheck:events -w @devjewels-channels/core
npm run selfcheck:catalog -w @devjewels-channels/core
npm run selfcheck:product-sync -w @devjewels-channels/core
```

### Still out of scope

- WooCommerce/Magento real adapters
- Product images: CDN thumbnail (+ Live when available) via `productCreateMedia`
- Querying `public` / `diamond` / `b2c` SoT tables from Channels
- Separate RDS or separate database name for Channels (MVP)
