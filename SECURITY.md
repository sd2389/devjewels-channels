# Security Policy

## Supported code

Only the latest `main` branch is supported.

## Reporting a vulnerability

Do **not** open a public issue for vulnerabilities, leaked credentials, OAuth/token handling flaws, webhook verification bypasses, authorization problems, queue poisoning, or other sensitive security issues.

Report security issues privately to the repository owner through GitHub's private vulnerability reporting feature when available.

Include the affected component, reproduction steps, impact, and a safe proof of concept when possible.

## Secrets and customer data

Never commit production tokens, Shopify credentials, AWS credentials, database URLs with real passwords, service tokens, customer identifiers/data, private dumps, or vault exports.

Only sanitized placeholders belong in `.env.example`, examples, tests, and documentation. If a credential is committed, rotate/revoke it immediately and then remove it from the repository/history as appropriate.

## Integration security expectations

- Verify webhook authenticity before processing.
- Keep OAuth and platform tokens server-side.
- Preserve idempotency on externally retried events.
- Keep the `channels` database role least-privileged and isolated from core schemas.
- Do not log secrets, bearer tokens, webhook signatures, or raw sensitive payloads.
- Validate all external event envelopes and provider responses.
