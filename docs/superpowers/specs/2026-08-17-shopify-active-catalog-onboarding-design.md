# Shopify ACTIVE catalog onboarding (Customer API → Channels)

**Date:** 2026-08-17  
**Status:** Approved for runbook / ops packaging (no new product scope unless gaps found)  
**Repos:** `devjewels-channels`, Customer API Access (backend), Partner Shopify Public app  
**Related:** [MANY_CUSTOMERS_PUBLIC_APP.md](../../MANY_CUSTOMERS_PUBLIC_APP.md), [CUSTOMER_API_REFERENCE.md](../../../devjewels-backend/docs/CUSTOMER_API_REFERENCE.md) (sibling repo)

## Problem

A DevJewels B2B customer already has a Shopify storefront. She wants DevJewels designs to appear as sellable products in that store. She is willing to pay for setup help. DevJewels already exposes a Customer API (`X-API-Key` + IP allowlist) and a Channels Shopify sync stack — the gap is a clear, billable onboarding path, not a greenfield bridge.

## Goals

- Put entitled DevJewels designs onto her existing Shopify shop as **ACTIVE** products.
- Keep API keys and Shopify tokens off the theme / browser.
- Reuse **Channels** (OAuth install + product/inventory sync) as the only supported path for this engagement.
- Catalog-only commercial package: shoppers check out on Shopify; DevJewels place-order via Customer API is **not** required for v1 of this package.
- One repeatable staff + merchant checklist suitable for paid setup.

## Non-goals (this package)

- Auto-creating DevJewels orders from Shopify checkouts (`sync_orders` / order reverse-sync).
- Building a one-off sync script or putting Customer API keys in Shopify Liquid/JS.
- New Custom Shopify app per customer (violates Partner multi-merchant model; use Public app).
- WooCommerce / Magento.
- Changing Customer API auth model (key + IP remain for direct API consumers; Channels uses service auth to Django `channels_api`).

## Decisions (approved)

| Topic | Choice |
|-------|--------|
| Scope | Catalog (+ inventory sync when enabled); no order reverse-sync yet |
| Product publish state | **ACTIVE** (Channels Shopify create/update already sets `status: "ACTIVE"`) |
| Integration vehicle | **devjewels-channels** Install Shopify flow |
| Entitlement source | Same as Customer API: active API key + approved designs / Design API Group |
| Merchant UX | Existing store; Install app once; pick inventory location |
| Secrets | Customer API key never in Shopify; Shopify offline token in Channels vault only |

## Architecture

```text
DevJewels (SoT)
  Customer API Access: key + design entitlements
  channels_api (service auth) ←── Channels workers
        │
        │ catalog.updated / inventory.updated events
        ▼
Channels (SST / API + SQS)
  connection (customer_id, shop, sync_products, sync_inventory, …)
  product_mapping / variant_mapping
        │
        │ Admin API (OAuth token)
        ▼
Merchant Shopify store
  Products ACTIVE on storefront
  Inventory at chosen location
```

**Publish rule:** Product create/update in `apps/shopify` uses `status: "ACTIVE"`. New entitled designs become live without a draft gate for this package.

**Dedupe rule:** Channels `product_mapping` / `variant_mapping` keyed by connection + design (and job for variants) — re-sync updates; does not blindly duplicate.

## Staff runbook (paid setup)

### A. One-time platform (you — if not already done)

1. Public Shopify app configured (see [MANY_CUSTOMERS_PUBLIC_APP.md](../../MANY_CUSTOMERS_PUBLIC_APP.md)).
2. Channels production URL + OAuth callback + compliance webhooks live.
3. Partner Client ID/Secret saved in Channels dashboard vault.
4. Django `feature_channels` + `CHANNELS_BASE_URL` / service token wired so catalog/inventory events reach Channels.

### B. Per customer (billable)

1. **Customer record** exists and is approved in DevJewels.
2. **Customer API Access:** create/activate API key; assign Design API Group / personal designs she may sell.
3. Confirm feed: key can see expected designs (Swagger unlock or `GET /products/feed/` from an allowlisted IP if she also uses the raw API).
4. **Channels dashboard:** select `customer_id` → enter `store.myshopify.com` → **Install Shopify**.
5. Merchant **Approves** app install in Shopify Admin.
6. Pick **inventory location**; ensure `sync_products` (and `sync_inventory` if stock should mirror) is on.
7. Trigger / wait for product sync; verify one design appears **ACTIVE** on storefront.
8. Hand off: short merchant note — “DevJewels products update automatically; do not delete mapped products by hand without telling us.”

### C. Merchant responsibilities

- Approve app install and keep the app installed.
- Choose which location holds DevJewels stock.
- Theme / collections / SEO on Shopify side (optional paid add-on, not core sync).
- Ordering from DevJewels remains her normal B2B process unless a later package enables order sync.

## Failure / denied paths

| Case | Expected |
|------|----------|
| No active API key / no entitled designs | Nothing (or empty) syncs to Shopify |
| App not installed / connection inactive | No product create/update |
| `sync_products=false` | Catalog jobs skipped |
| Wrong shop domain | OAuth fails; connection not created |
| Revoked design entitlement | Product sync delete/unpublish path per existing Channels behavior |

## Verification

1. Staff: customer has active key + ≥1 entitled design.  
2. Merchant: Install succeeds; connection shows active in Channels.  
3. Success: design visible as **ACTIVE** Shopify product with expected title/image/price rules.  
4. Denied: revoke design or deactivate connection → product no longer updated / removed per Channels rules; storefront does not keep selling revoked catalog via sync.  
5. Security: no Customer API key in theme code or browser network tab for storefront pages.

## Open follow-ups (not blocking this package)

- Formal merchant PDF / email template from this runbook.
- Optional paid add-on: order reverse-sync (`sync_orders`).
- Optional: draft-first mode if a future customer wants review before ACTIVE (would be a product change; not this engagement).

## Spec self-review

- No TBD placeholders for core path.
- Scope matches user choices: catalog A + ACTIVE + Channels.
- No conflict with Public-app multi-customer policy.
- Implementation plan only needed if production gaps appear (OAuth, deploy, feature flag); otherwise this is ops packaging.
