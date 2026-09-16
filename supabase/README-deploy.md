
## Edge function deploys must keep JWT verification OFF for `sync`

`sync` and `check-alerts` are invoked by pg_cron, which sends no user JWT. Both
run `verify_jwt = false` and enforce authorization in-function instead (the cron
secret, or a row in `household_members`).

A deploy made through tooling that does not carry that flag silently turns
verification back ON. The platform then rejects the cron's call with
`UNAUTHORIZED_NO_AUTH_HEADER` **before the function runs**, so nothing appears in
the function's own logs and the nightly sync simply stops happening. This
happened on 2026-09-15.

    supabase functions deploy sync --no-verify-jwt --project-ref <ref>

`private.invoke_edge_function` now also sends the project's publishable key as a
bearer token, so the cron path survives the toggle either way. That is a
backstop, not a licence to leave the flag wrong.
