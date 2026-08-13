# woocommerce_* migrations

Phase 3: add `woocommerce_oauth_state`, `woocommerce_webhook_key`, etc. here.
Same Postgres database as DevJewels; tables in schema `channels` only (no separate DB).
Do not put Woo-only columns on shared `channels.connection`.
