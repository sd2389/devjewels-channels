# Shopify ACTIVE Catalog Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package a repeatable, billable onboarding path so a DevJewels customer with an existing Shopify store gets entitled designs as **ACTIVE** Shopify products via Channels (catalog + optional inventory; no order reverse-sync).

**Architecture:** No new sync engine. Product/inventory sync already lives in `devjewels-channels` (OAuth connection → `product_mapping` / workers → Shopify Admin API `status: "ACTIVE"`). This plan ships ops docs + a production readiness checklist + a merchant handoff template, and verifies platform prerequisites (`feature_channels`, Public app, Channels host).

**Tech Stack:** `devjewels-channels` (SST/HTTP API + Next dashboard), Shopify Public app OAuth, Django `channels_api` + `feature_channels`, Customer API Access entitlements.

**Spec:** `docs/superpowers/specs/2026-08-17-shopify-active-catalog-onboarding-design.md`

## Global Constraints

- Catalog package only: `sync_orders` stays off for this engagement.
- Shopify products must publish as **ACTIVE** (existing create/update path; do not change to DRAFT).
- Never put Customer API keys or Shopify tokens in theme Liquid/JS or committed files.
- Use Public Shopify app multi-merchant Install flow — not a new Custom app per customer.
- Channels never queries Django `public` / `diamond` / `b2c` tables; catalog goes through `channels_api` HTTP only.
- YAGNI: do not rebuild product sync; only document + verify + fill real production gaps.

---

## File structure (docs packaging)

| File | Responsibility |
|------|----------------|
| `docs/runbooks/SHOPIFY_ACTIVE_CATALOG_ONBOARDING.md` | Staff step-by-step for one paid customer |
| `docs/runbooks/MERCHANT_SHOPIFY_HANDOFF.md` | Short copy pasteable to the merchant after Install |
| `docs/MANY_CUSTOMERS_PUBLIC_APP.md` | Existing Partner app checklist — add link to runbooks |
| `README.md` | One-line pointer to onboarding runbook |
| `docs/superpowers/plans/2026-08-17-shopify-active-catalog-onboarding.md` | This plan |

No mandatory code changes unless Task 1 finds a production gap (then open a follow-up plan; do not expand this package).

---

### Task 1: Production readiness gap checklist (verify, don’t invent)

**Files:**
- Create: `docs/runbooks/SHOPIFY_ACTIVE_CATALOG_ONBOARDING.md` (checklist section only first; Task 2 fills full runbook)
- Reference (read-only): `docs/MANY_CUSTOMERS_PUBLIC_APP.md`, `docs/AWS_DEPLOY.md`, `README.md`, backend `apps/channels_api/`, `.env.example` files

**Interfaces:**
- Consumes: Spec decisions (ACTIVE, catalog-only, Channels Install)
- Produces: Written pass/fail for each prerequisite below (filled into the runbook “Prerequisites” table)

- [ ] **Step 1: Confirm Shopify create/update still forces ACTIVE**

Run from repo root:

```bash
cd /Users/smitdesai/Coding/devjewels-channels
rg -n 'status:\s*"ACTIVE"' apps/shopify/src/products.ts
```

Expected: at least two hits on product create and product update paths (today ~lines 346 and 427). If DRAFT appears instead, stop and escalate — do not onboard as ACTIVE package.

- [ ] **Step 2: Confirm product-sync denied path when `sync_products` is false**

```bash
cd /Users/smitdesai/Coding/devjewels-channels
npm run selfcheck:product-sync -w @devjewels-channels/core
```

Expected: exits 0; selfcheck covers create/update and skipped when `sync_products: false`.

- [ ] **Step 3: Fill prerequisites table (live env — ask user for secrets; do not invent values)**

Create file start:

```markdown
# Shopify ACTIVE catalog onboarding (staff runbook)

## Prerequisites (fill per environment)

| Check | How | Status (pass/fail) | Notes |
|-------|-----|--------------------|-------|
| Public Shopify app | Partner dashboard / `MANY_CUSTOMERS_PUBLIC_APP.md` | | |
| OAuth Client ID/Secret in Channels vault | Dashboard OAuth config | | |
| `CHANNELS_PUBLIC_BASE_URL` HTTPS | prod env | | |
| Compliance webhooks → `/api/shopify/webhooks` | Partner app | | |
| Django `feature_channels` enabled | Feature flags admin | | |
| `CHANNELS_BASE_URL` + `CHANNELS_SERVICE_TOKEN` on Django | Infisical / `.env` | | |
| Channels deploy healthy | `docs/AWS_DEPLOY.md` | | |
| Product sync ACTIVE | `rg` Step 1 | | |
```

Ask the user for any unknown prod values; mark fail rows explicitly. Do not put secrets in the markdown.

- [ ] **Step 4: Commit (only if user asked to commit)**

If user requested commit:

```bash
cd /Users/smitdesai/Coding/devjewels-channels
git add docs/runbooks/SHOPIFY_ACTIVE_CATALOG_ONBOARDING.md
git commit -m "$(cat <<'EOF'
docs: add Shopify ACTIVE catalog onboarding prerequisites

EOF
)"
```

If user did not ask to commit, skip.

---

### Task 2: Complete staff runbook (per-customer paid setup)

**Files:**
- Modify: `docs/runbooks/SHOPIFY_ACTIVE_CATALOG_ONBOARDING.md`
- Reference: `docs/superpowers/specs/2026-08-17-shopify-active-catalog-onboarding-design.md`

**Interfaces:**
- Consumes: Prerequisites table from Task 1
- Produces: Ordered B/C steps staff can follow for one customer without reading source

- [ ] **Step 1: Append per-customer procedure**

Append exactly this structure (adapt only if UI labels differ after reading `ConnectDashboard.tsx`):

```markdown
## Per-customer procedure (billable)

### 1. Entitlements (DevJewels admin)

1. Confirm customer is approved/active.
2. Admin → Customer API Access: create or confirm **active** API key.
3. Assign Design API Group and/or personal designs she may sell.
4. Smoke (optional raw API from allowlisted IP):

```bash
curl -sS -H "X-API-Key: $CUSTOMER_API_KEY" \
  "$DEVJEWELS_API_BASE/api/v1/customer/me"
curl -sS -H "X-API-Key: $CUSTOMER_API_KEY" \
  "$DEVJEWELS_API_BASE/api/v1/products/feed/?limit=5"
```

Expected: 200; feed contains the designs you entitled.

### 2. Connect Shopify (Channels)

1. Open Channels dashboard.
2. Select customer → enter `store.myshopify.com` → **Install Shopify**.
3. Merchant Approves in Shopify Admin.
4. Pick inventory location.
5. Confirm flags: `sync_products=true`; `sync_inventory=true` only if stock should mirror; **`sync_orders=false`** for this package.

### 3. Verify ACTIVE catalog

1. Wait for product sync / trigger catalog import if dashboard exposes it.
2. In Shopify Admin → Products: find a known `design_no`; status **Active**.
3. Open storefront PDP; product is buyable.
4. Denied check: temporarily turn off `sync_products` or revoke one design entitlement; confirm sync no longer updates that design (per Channels revoke behavior).

### 4. Hand off

Send `docs/runbooks/MERCHANT_SHOPIFY_HANDOFF.md` content to the merchant.
```

- [ ] **Step 2: Self-review against spec**

Checklist (all must be true in the runbook):

- ACTIVE publish stated
- No order reverse-sync in package
- API key never in theme
- Install via Channels / Public app
- Success + denied verification steps present

- [ ] **Step 3: Commit only if user asked**

```bash
git add docs/runbooks/SHOPIFY_ACTIVE_CATALOG_ONBOARDING.md
git commit -m "$(cat <<'EOF'
docs: complete staff runbook for Shopify ACTIVE catalog onboarding

EOF
)"
```

---

### Task 3: Merchant handoff template

**Files:**
- Create: `docs/runbooks/MERCHANT_SHOPIFY_HANDOFF.md`

**Interfaces:**
- Consumes: Package boundaries from spec
- Produces: Copy merchants can receive by email without internal jargon overload

- [ ] **Step 1: Write merchant-facing copy**

```markdown
# Your DevJewels catalog on Shopify

## What we set up

- DevJewels designs you are entitled to sync into your Shopify store as **live (Active)** products.
- Stock can update automatically when live inventory sync is enabled.
- Shoppers check out on **your** Shopify store as usual.

## What you do

1. Approve the **DevJewels Channels** app install when prompted.
2. Keep the app installed.
3. Tell us if you change your primary inventory location.
4. Do not manually delete synced DevJewels products without telling us — remapping may break.

## What we do not do in this package

- Orders from Shopify are **not** automatically sent to DevJewels. Continue ordering from DevJewels the way you do today (portal / sales contact / API if you use it separately).

## Security

- Never paste API keys into your Shopify theme or public apps.
- Only staff with your Shopify Admin access should manage the Channels app.
```

- [ ] **Step 2: Sanity read aloud**

Confirm a non-engineer merchant understands Active products + no auto order to DevJewels.

- [ ] **Step 3: Commit only if user asked**

```bash
git add docs/runbooks/MERCHANT_SHOPIFY_HANDOFF.md
git commit -m "$(cat <<'EOF'
docs: add merchant handoff for Shopify catalog sync

EOF
)"
```

---

### Task 4: Cross-link docs

**Files:**
- Modify: `docs/MANY_CUSTOMERS_PUBLIC_APP.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-17-shopify-active-catalog-onboarding-design.md` (add “Runbooks” link at top)

**Interfaces:**
- Consumes: Paths from Tasks 2–3
- Produces: Discoverable entry points from existing Channel docs

- [ ] **Step 1: Add runbook link to Public app doc**

At the top of `docs/MANY_CUSTOMERS_PUBLIC_APP.md` after the title, add:

```markdown
**Staff onboarding (ACTIVE catalog package):** [SHOPIFY_ACTIVE_CATALOG_ONBOARDING.md](./runbooks/SHOPIFY_ACTIVE_CATALOG_ONBOARDING.md)  
**Merchant handoff:** [MERCHANT_SHOPIFY_HANDOFF.md](./runbooks/MERCHANT_SHOPIFY_HANDOFF.md)
```

- [ ] **Step 2: Add README pointer**

In `README.md` under “Useful paths once running” (or Shopify OAuth section), add:

```markdown
- Staff: Shopify ACTIVE catalog paid onboarding → `docs/runbooks/SHOPIFY_ACTIVE_CATALOG_ONBOARDING.md`
```

- [ ] **Step 3: Link from spec**

Under the spec header, add:

```markdown
**Runbooks:** [staff](../../runbooks/SHOPIFY_ACTIVE_CATALOG_ONBOARDING.md) · [merchant](../../runbooks/MERCHANT_SHOPIFY_HANDOFF.md)
```

- [ ] **Step 4: Commit only if user asked**

```bash
git add docs/MANY_CUSTOMERS_PUBLIC_APP.md README.md docs/superpowers/specs/2026-08-17-shopify-active-catalog-onboarding-design.md
git commit -m "$(cat <<'EOF'
docs: link Shopify ACTIVE catalog onboarding runbooks

EOF
)"
```

---

### Task 5: First-customer dry run (ops, with user)

**Files:** none (operational)

**Interfaces:**
- Consumes: Completed runbooks + pass prerequisites
- Produces: Written result (success/fail) for the real or staging shop

- [ ] **Step 1: Confirm with user**

Need from user before executing:

1. Customer id / name  
2. `*.myshopify.com` domain  
3. Whether prod Channels + `feature_channels` are already live  
4. Whether to enable `sync_inventory` for this merchant  

- [ ] **Step 2: Execute staff runbook sections 1–3**

Follow `SHOPIFY_ACTIVE_CATALOG_ONBOARDING.md` with those values. Do not invent API keys or shop domains.

- [ ] **Step 3: Record verification evidence**

Write into the runbook “Last dry run” section:

```markdown
## Last dry run

| Field | Value |
|-------|-------|
| Date | |
| Customer id | |
| Shop | |
| Design verified ACTIVE | |
| Inventory sync on? | |
| Result | pass / fail |
| Blocker | |
```

- [ ] **Step 4: Send merchant handoff**

Only after pass: paste `MERCHANT_SHOPIFY_HANDOFF.md` to the customer.

---

## Spec coverage (self-review)

| Spec requirement | Task |
|------------------|------|
| ACTIVE catalog on existing Shopify | Task 1 Step 1, Task 2 verify, Task 5 |
| Channels Install path | Task 2 |
| Entitlements via Customer API Access | Task 2 |
| No order reverse-sync | Task 2 flags + Task 3 merchant copy |
| Secrets off theme | Task 3 |
| Public app / not Custom per customer | Task 1 prerequisites + existing MANY_CUSTOMERS doc |
| Staff + merchant checklist | Tasks 2–3 |
| Verification success + denied | Task 2 §3 |
| Formal merchant template | Task 3 (addresses open follow-up in spec) |

## Placeholder scan

No TBD/TODO implementation steps. Prod secret values are explicitly “ask user,” not invented.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-17-shopify-active-catalog-onboarding.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — run tasks in this session with checkpoints  

**Which approach?**
