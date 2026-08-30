# Contributing

DevJewels Channels is a public repository with a review-first contribution workflow. Direct changes to `main` are not part of the contribution process.

## Required workflow

1. Fork the repository or create a feature branch if you have write access.
2. Keep each change narrowly scoped.
3. Open a pull request against `main`.
4. Explain the problem, implementation, tests, security impact, data-migration impact, and rollback considerations.
5. Do not merge until required CI checks pass and required review is complete.

## Before opening a pull request

Run:

```bash
npm ci
npm run typecheck
npm run build
```

Run the relevant self-checks for any changed integration or event path.

## Pull-request rules

- No direct commits to `main`.
- No force pushes to protected branches.
- No merge while required checks are failing or pending.
- No production credentials, API tokens, customer data, private database dumps, or vault exports.
- No bypassing HMAC verification, OAuth state validation, tenant/customer boundaries, idempotency, queue retry behavior, or least-privilege database isolation.
- No direct reads from DevJewels core schemas; use the documented service/API boundary.
- No disabling checks merely to make CI pass.
- No broad dependency additions without justification.
- Changes to OAuth, webhooks, SQS/DLQs, database migrations, IAM, SST, deployment, secrets, or sync workers require explicit reviewer attention.

## Engineering expectations

External inputs are untrusted. Event handlers must be retry-safe. Webhooks must be authenticated before side effects. Queue consumers must tolerate duplicates and partial failures. Database changes must preserve the `channels` schema boundary and least-privilege role. Secrets must stay outside source, logs, and database rows.

## Commit and PR quality

Use descriptive commits. Keep generated or deployment artifacts out of source unless intentionally tracked. Include tests/self-check evidence and operational impact for non-trivial changes.