# AWS Deploy — DevJewels Channels (SST Ion)

Channels is **not** EC2/Docker like the backend, and **not** CloudFront/Next on AWS.

SST provisions:

| Resource | SST component | Purpose |
|----------|---------------|---------|
| HTTP API | `sst.aws.ApiGatewayV2` (`ChannelsApi`) | Ingest, Shopify OAuth/webhooks, admin APIs |
| Lambda router | `sst.aws.Function` (`ChannelsHttp`) | `apps/core/src/http/handler.ts` |
| SQS + DLQs | `sst.aws.Queue` | Inventory / Order / Product / Price |
| Lambda workers | `queue.subscribe(...)` | Process SQS jobs |

Local Connect dashboard (`npm run dev` / Next) is **optional ops UI only** — not deployed to AWS.

Same Postgres DB as DevJewels (`channels` schema only). No separate RDS.

## Auth model (mirror backend)

Same two OIDC trusts as `devjewels-backend/.github/workflows/deploy.yml`:

1. **GitHub → AWS** — `aws-actions/configure-aws-credentials` assumes `arn:aws:iam::$AWS_ACCOUNT_ID:role/$AWS_ROLE_NAME`
2. **GitHub → Infisical** — `Infisical/secrets-action` with `method: oidc` + machine identity

`permissions: id-token: write` is required on the workflow (already set).

### GitHub repo secrets (`devjewels-channels`)

| Secret | Notes |
|--------|--------|
| `INFISICAL_MACHINE_IDENTITY_ID` | New Channels machine identity UUID |
| `INFISICAL_PROJECT_SLUG` | **Dedicated Channels project** slug |
| `INFISICAL_ENV_SLUG` | production Infisical env (e.g. `prod` / `production`) |
| `AWS_ACCOUNT_ID` | Same account as backend unless split |
| `AWS_ROLE_NAME` | **Channels** IAM role (SST — not ECR-only backend role) |
| `AWS_REGION` | `us-east-2` |
| `SNS_DEPLOY_TOPIC_ARN` | Optional; defaults to backend alarms topic |

### Infisical secrets (Channels project, production, path `/`)

No path folders — secrets at project root `/`.

**Required**

| Key | Example / notes |
|-----|-----------------|
| `DATABASE_URL` | `postgresql://channels_app:***@HOST:5432/devjewels?sslmode=require&options=-csearch_path%3Dchannels` |
| `CHANNELS_SERVICE_TOKEN` | Same token Django `channels_api` expects |
| `DEVJEWELS_API_BASE_URL` | `https://storeapi.devjewels.com` (internal SoT HTTP) |
| `AWS_SECURITY_GROUP_IDS` | Lambda ENI security group(s) |
| `AWS_SUBNET_IDS` | VPC subnets with NAT for egress |

**Strongly recommended (prod)**

| Key | Notes |
|-----|--------|
| `AWS_REGION` | `us-east-2` |
| `AWS_NAME_PREFIX` | `devjewels-channels` → `devjewels-channels-production-http` etc. |
| `AWS_VPC_ID` | Existing VPC |
| `CHANNELS_DOMAIN` | e.g. `channels.devjewels.com` |
| `AWS_ACM_CERTIFICATE_ARN` | Existing ACM ARN in `AWS_REGION` covering domain |
| `AWS_ROUTE53_ZONE_ID` | Optional; omit if DNS is external (`dns: false` + ACM) |
| `CHANNELS_PUBLIC_BASE_URL` | `https://channels.devjewels.com` |
| `CHANNELS_OAUTH_SUCCESS_URL` | Admin return URL after Shopify OAuth |
| `CHANNELS_CORS_ORIGINS` | Comma-separated admin origins |
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | Partner app credentials |

Lambdas stay **in VPC** (RDS SG allows `172.16.0.0/16`). NAT required for Shopify/HTTPS.

## IAM role for SST (GitHub OIDC)

Backend role is enough for ECR + SSM. Channels needs **SST bootstrap + app resources**.

Trust policy (same pattern as backend):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:ORG/devjewels-channels:*"
        }
      }
    }
  ]
}
```

Permissions (pragmatic MVP — tighten later):

- SST bootstrap: S3, SSM Parameter Store, IAM (passrole/create for Lambda roles), CloudFormation
- App: Lambda, SQS, API Gateway, ACM, Route53 (if custom domain), Logs, EC2 (ENIs if VPC)
- **Not needed:** CloudFront, S3 static hosting, OpenNext

Create a dedicated role e.g. `devjewels-channels-github-oidc` and set `AWS_ROLE_NAME` to that.

## One-time AWS / Infisical checklist

1. Infisical: dedicated Channels project; secrets at `/` in production; attach GitHub OIDC machine identity.
2. AWS: OIDC provider already exists for backend — add trust for `devjewels-channels` repo on a new role (or extend trust).
3. RDS: ensure `channels` schema + `channels_app` role grants applied (`apps/core/src/db/shared/*.sql`).
4. Security groups: Lambda SGs → allow egress to RDS:5432; RDS SG → allow ingress from those SGs.
5. GitHub: set repo secrets listed above.
6. Deploy: push to `main` or Actions → **Deploy Channels (SST)** (always `--stage production`).
7. After deploy: ensure DNS → API Gateway; Shopify redirect/webhook URLs; Django `CHANNELS_BASE_URL`.
8. Point Django `CHANNELS_SERVICE_TOKEN` at the same Infisical token.

## Local deploy (optional)

```bash
cd /home/viresh/Electromech/personal/Free/Dev-Jewels/devjewels-channels
cp .env.example .env   # fill DATABASE_URL, CHANNELS_SERVICE_TOKEN, DEVJEWELS_API_BASE_URL
aws sso login          # or export AWS_* for an admin/deploy role
npm ci
npm run sst:deploy -- --stage production
```

## Gotchas that break prod

1. **Workers need env** — shared Infisical env is passed into HTTP + SQS Lambdas.
2. **File vault on Lambda** — `.data/secrets` does not persist; use Infisical `SHOPIFY_API_*`.
3. **Private RDS without VPC** — set `AWS_SECURITY_GROUP_IDS` + `AWS_PRIVATE_SUBNET_IDS`.
4. **Non-production stage** — rejected; only `--stage production`.
5. **OIDC** — do not reuse backend ECR-only role (needs API Gateway + Lambda + SQS).
6. **Django URL** — `CHANNELS_BASE_URL=https://channels.devjewels.com` → `/api/internal/events`.

## HTTP surface (API Gateway)

| Method | Path | Caller |
|--------|------|--------|
| `GET` | `/health` | probes |
| `POST` | `/api/internal/events` | Django `ChannelsEventPublisher` |
| `POST` | `/api/shopify/webhooks` | Shopify |
| `GET` | `/api/shopify/auth` | staff / admin |
| `GET` | `/api/shopify/auth/callback` | Shopify OAuth |
| `*` | `/api/admin/*` | admin tooling |

## Workflow

`.github/workflows/deploy.yml` — Infisical OIDC → AWS OIDC → `npm ci` → `sst deploy --stage production`
