-- Where this item's webhooks were last pointed. sync calls /item/webhook/update
-- for any item whose value differs from the plaid-webhook URL, then records it,
-- so items linked before webhooks existed pick one up without a re-link.
alter table public.plaid_items add column if not exists webhook_url text;

-- A per-item lease, so overlapping runs (webhook, app open, Sync now, nightly)
-- never drain one cursor twice. Set when a run takes the item, cleared when it
-- finishes, and treated as expired after ten minutes. See takeLease in sync.
alter table public.plaid_items add column if not exists sync_started_at timestamptz;
