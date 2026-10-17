-- Projections must not outrank a confirmed reading.
--
-- recompute_derived step (3) wrote, each night, a balance dated today projected
-- from each debt schedule's seeded anchor. account_balance_current takes the
-- newest as_of, so the morning after a manual reading was entered the
-- projection replaced it (a confirmed loan reading was about to be replaced by one $324 higher).
-- Step (3) now anchors on the latest non-derived reading and adds only the
-- schedule's movement since then. Steps (1) and (2) are unchanged.

CREATE OR REPLACE FUNCTION public.recompute_derived()
 RETURNS TABLE(derived_rows integer, projected_rows integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  a record; wk date; bal numeric; mov numeric;
  real_bal numeric; real_on date;
  first_week date;
  this_week  date := date_trunc('week', current_date::timestamptz)::date;
  n_hist int := 0; n_proj int := 0;
begin
  select date_trunc('week', min(posted_on)::timestamptz)::date into first_week from transactions;

  delete from balance_snapshots b
  where b.source = 'derived'
    and (
      exists (select 1 from transactions t where t.account_id = b.account_id)
      or exists (select 1 from debt_schedules d where d.account_id = b.account_id)
    );

  -- (1) backwards, from each account's own feed
  if first_week is not null then
    for a in
      select ac.id, c.balance as current_bal
      from accounts ac join account_balance_current c on c.account_id = ac.id
      where ac.kind in ('card','loan','tax')
        and exists (select 1 from transactions t where t.account_id = ac.id)
    loop
      wk := this_week;
      while wk > first_week loop
        wk := wk - 7;
        select coalesce(sum(t.amount), 0) into mov
        from transactions t where t.account_id = a.id and t.posted_on > (wk + 6);
        bal := greatest(a.current_bal - mov, 0);
        insert into balance_snapshots (account_id, balance, as_of, source)
        values (a.id, round(bal, 2), wk + 6, 'derived')
        on conflict (account_id, as_of, source) do update set balance = excluded.balance;
        n_hist := n_hist + 1;
      end loop;
    end loop;
  end if;

  -- (2) nothing owed before the money was borrowed
  if first_week is not null then
    for a in
      select account_id, origination_date from debt_schedules where origination_date is not null
    loop
      wk := this_week;
      while wk > first_week loop
        wk := wk - 7;
        if (wk + 6) < a.origination_date then
          insert into balance_snapshots (account_id, balance, as_of, source)
          values (a.account_id, 0, wk + 6, 'derived')
          on conflict (account_id, as_of, source) do update set balance = excluded.balance;
          n_hist := n_hist + 1;
        end if;
      end loop;
    end loop;
  end if;

  -- (3) forwards, from each schedule — anchored on the latest REAL reading.
  --
  -- The schedule's own anchor is a seeded figure, and projecting from it alone
  -- wrote a balance dated today that outranked a confirmed manual reading
  -- entered yesterday (the current balance is the newest as_of). Now the
  -- schedule only supplies the MOVEMENT since that reading; a reading taken
  -- today is left alone entirely.
  for a in select account_id from debt_schedules loop
    select b.balance, b.as_of into real_bal, real_on
    from balance_snapshots b
    where b.account_id = a.account_id and b.source <> 'derived' and b.as_of <= current_date
    order by b.as_of desc, b.created_at desc
    limit 1;

    if real_on is not null and real_on >= current_date then
      continue;
    end if;

    bal := projected_balance(a.account_id, current_date);
    if bal is not null and real_on is not null then
      bal := greatest(round(real_bal + bal - projected_balance(a.account_id, real_on), 2), 0);
    end if;
    if bal is not null then
      insert into balance_snapshots (account_id, balance, as_of, source)
      values (a.account_id, bal, current_date, 'derived')
      on conflict (account_id, as_of, source) do update set balance = excluded.balance;
      n_proj := n_proj + 1;
    end if;
  end loop;

  return query select n_hist, n_proj;
end $function$;
