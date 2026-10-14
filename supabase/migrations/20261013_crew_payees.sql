-- People the business pays. When one of them is paid from a HOUSEHOLD account,
-- the payment nets the draw that funded it (categorize.ts step 2b) instead of
-- the pass-through reading as household income.
create table if not exists public.crew_payees (
  id uuid primary key default gen_random_uuid(),
  match_text text not null unique,
  label text,
  created_at timestamptz not null default now()
);

alter table public.crew_payees enable row level security;

drop policy if exists member_all on public.crew_payees;
create policy member_all on public.crew_payees
  for all using (is_household_member()) with check (is_household_member());

insert into public.crew_payees (match_text, label) values
  ('ruslan', 'Ruslan'),
  ('pablo', 'Pablo'),
  ('yanelis', 'Yanelis')
on conflict (match_text) do nothing;
