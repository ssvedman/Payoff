-- ============================================================================
-- Frozen plan projections — plan_versions + plan_projections
-- ============================================================================
--
-- The Progress chart used to simulate both projection lines from CURRENT
-- balances on every render, so "the plan" moved whenever a balance moved. A
-- target that shifts to meet you cannot be missed, and the comparison the page
-- exists to make was impossible.
--
-- Both lines are now computed once, stored, and never recomputed. Only the
-- actual line changes.
--
-- The freeze is enforced HERE rather than by convention in the client:
-- household members hold SELECT and nothing else on both tables. Generating a
-- version is service_role work (the generate-plan-version edge function), which
-- bypasses RLS. A member with the publishable key cannot edit a stored
-- projection even by accident, and a bug in the app cannot either.
-- ============================================================================

create table if not exists public.plan_versions (
  id              uuid primary key default gen_random_uuid(),
  version         int not null,
  effective_from  date not null,
  attack_fund     numeric(10,2) not null,
  monthly_savings numeric(10,2) not null,
  deposit_target  numeric(12,2) not null,
  baseline_debt   numeric(12,2) not null,
  reason          text,
  is_current      boolean not null default true,
  created_at      timestamptz not null default now(),
  constraint plan_versions_version_unique unique (version)
);

-- Exactly one current version. A revision flips the old row to false and
-- inserts the new one; this makes "two current plans" unrepresentable rather
-- than merely discouraged.
create unique index if not exists plan_versions_one_current
  on public.plan_versions (is_current)
  where is_current;

create table if not exists public.plan_projections (
  id                  uuid primary key default gen_random_uuid(),
  plan_version_id     uuid not null references public.plan_versions(id) on delete cascade,
  scenario            text not null check (scenario in ('plan','minimums_only')),
  month_index         int not null,
  projected_on        date not null,
  projected_debt      numeric(12,2) not null,
  cumulative_interest numeric(12,2) not null,
  projected_savings   numeric(12,2) not null,
  projected_net_worth numeric(12,2),
  accounts_cleared    text[],
  unique (plan_version_id, scenario, month_index)
);

-- month_index 0 is the starting state, so the chart's first point is the
-- baseline rather than the first month's result.
create index if not exists plan_projections_lookup
  on public.plan_projections (plan_version_id, scenario, month_index);


-- ----------------------------------------------------------------------------
-- A stored projection is immutable.
--
-- The unique index above stops a second current version; this stops the row
-- itself being rewritten. Deleting a whole version still works (and cascades),
-- because withdrawing a bad version is a legitimate act — silently moving the
-- line it drew is not.
-- ----------------------------------------------------------------------------

create or replace function public.freeze_plan_projections()
returns trigger
language plpgsql
as $function$
begin
  raise exception
    'plan_projections rows are frozen. Create a new plan version instead of editing version %.',
    old.plan_version_id
    using errcode = 'restrict_violation';
end $function$;

drop trigger if exists freeze_plan_projections on public.plan_projections;
create trigger freeze_plan_projections
  before update on public.plan_projections
  for each row execute function public.freeze_plan_projections();


-- ----------------------------------------------------------------------------
-- RLS — read-only to members, written only by service_role
-- ----------------------------------------------------------------------------

alter table public.plan_versions    enable row level security;
alter table public.plan_projections enable row level security;

drop policy if exists member_read on public.plan_versions;
create policy member_read on public.plan_versions
  for select using (is_household_member());

drop policy if exists member_read on public.plan_projections;
create policy member_read on public.plan_projections
  for select using (is_household_member());

-- Supabase's defaults hand anon and authenticated the full write set on every
-- new table. RLS with a SELECT-only policy already denies those writes, but the
-- grant is revoked as well so the intent survives someone adding a broader
-- policy later without reading this block.
revoke insert, update, delete, truncate on public.plan_versions    from anon, authenticated;
revoke insert, update, delete, truncate on public.plan_projections from anon, authenticated;

grant select on public.plan_versions    to anon, authenticated;
grant select on public.plan_projections to anon, authenticated;
grant all    on public.plan_versions    to service_role;
grant all    on public.plan_projections to service_role;


-- ----------------------------------------------------------------------------
-- Audit, as every other table
-- ----------------------------------------------------------------------------

drop trigger if exists audit_plan_versions on public.plan_versions;
create trigger audit_plan_versions
  after insert or update or delete on public.plan_versions
  for each row execute function write_audit();

-- Projections are audited on DELETE only, following the convention the rest of
-- the schema states: audit the abnormal path, not the normal one. Generating a
-- version inserts ~200 rows at once and is already recorded by the
-- plan_versions row above; UPDATE cannot happen at all. Withdrawing a version
-- is the act worth a record.
drop trigger if exists audit_plan_projections on public.plan_projections;
create trigger audit_plan_projections
  after delete on public.plan_projections
  for each row execute function write_audit();
