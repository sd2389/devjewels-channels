## Summary

Describe what changed and why.

## Scope

- [ ] Change is narrowly scoped
- [ ] No unrelated refactors are included

## Validation

- [ ] `npm ci`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] Relevant integration/self-checks run

## Security / privacy

- [ ] No secrets, credentials, customer data, private dumps, or production payloads are included
- [ ] OAuth/webhook authentication impact reviewed
- [ ] Tenant/customer authorization impact reviewed
- [ ] Logs do not expose credentials or sensitive payloads

## Reliability

- [ ] Idempotency/retry behavior considered
- [ ] SQS/DLQ behavior considered where relevant
- [ ] Database migration impact considered
- [ ] Failure and rollback behavior described for risky changes

## Architecture

- [ ] `channels` schema boundary preserved
- [ ] No direct dependency on DevJewels core tables introduced
- [ ] Platform adapters remain isolated behind core contracts

## Notes for reviewer

Call out changes to OAuth, webhooks, IAM, SST, queues, database access, secrets, or deployment explicitly.