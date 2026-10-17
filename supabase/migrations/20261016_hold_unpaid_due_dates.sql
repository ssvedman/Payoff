-- Hold a typed-in due date until it is paid.
--
-- roll_scheduled_due_dates moved every account with a due_day to next month
-- the morning after its due date, paid or not. A missed payment on a manual
-- card therefore read "due in 30 days" by breakfast and was never flagged.
--
-- Now a passed due date only moves on when a payment is on record for it:
-- last_payment_on (kept by sync from the transaction feed) on or after 25 days
-- before that due date, which covers paying early once the statement cuts.
-- One cycle at a time, so two missed months stay two missed months.
--
-- Rolled freely, as before:
--   - a cleared account, which owes nothing;
--   - an account with NO payment ever on record. Its payments are not visible
--     to sync (no descriptor matches), so their absence proves nothing, and
--     holding it would report a bill as late for want of an alias.
--
-- Also fixes due_day 29-31 in a short month, which make_date rejected.

create or replace function public.due_on(y int, m int, dd int)
returns date
language sql
immutable
set search_path to 'public'
as $$
  select make_date(y, m, least(dd, extract(day from (make_date(y, m, 1) + interval '1 month - 1 day'))::int))
$$;

create or replace function public.roll_scheduled_due_dates()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r record;
  d date;
  steps int;
  n int := 0;
begin
  for r in
    select id, due_day, next_due_on, last_payment_on, cleared_at
    from accounts
    where due_day is not null
  loop
    d := r.next_due_on;

    if d is null then
      d := due_on(extract(year from current_date)::int, extract(month from current_date)::int, r.due_day);
      if d < current_date then
        d := due_on(extract(year from current_date + interval '1 month')::int,
                    extract(month from current_date + interval '1 month')::int, r.due_day);
      end if;
    else
      steps := 0;
      while d < current_date
        and steps < 36
        and (r.cleared_at is not null
             or r.last_payment_on is null
             or r.last_payment_on >= d - 25)
      loop
        d := due_on(extract(year from d + interval '1 month')::int,
                    extract(month from d + interval '1 month')::int, r.due_day);
        steps := steps + 1;
      end loop;
    end if;

    if d is distinct from r.next_due_on then
      update accounts set next_due_on = d where id = r.id;
      n := n + 1;
    end if;
  end loop;

  return n;
end $function$;

revoke execute on function public.roll_scheduled_due_dates() from public, anon, authenticated;
