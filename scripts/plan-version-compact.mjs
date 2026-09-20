/**
 * The same generated version as generate-plan-version.mjs, emitted compactly.
 *
 * Only the two series that cannot be re-derived — projected debt and cumulative
 * interest — are written out as literals. The date, the savings line and net
 * worth are all functions of the month index and the version's own parameters,
 * so they are computed in SQL from the values already stored on the
 * plan_versions row. Fewer transcribed figures is fewer chances to transcribe
 * one wrongly, and each derived column is then provably consistent with the
 * version it belongs to.
 *
 *   node scripts/plan-version-compact.mjs <state.json>
 */

import { build } from 'esbuild'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const statePath = process.argv[2]
const bundlePath = join(tmpdir(), `payoff-plan-compact-${process.pid}.mjs`)
await build({
  entryPoints: ['src/lib/planGeneration.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundlePath,
  logLevel: 'warning',
})
const { generatePlan } = await import(`file://${bundlePath}`)
const state = JSON.parse(await readFile(statePath, 'utf8'))
const { version, rows, summary } = generatePlan(state.input)
await rm(bundlePath, { force: true })

const q = (s) => `'${String(s).replace(/'/g, "''")}'`
const series = (scenario) =>
  rows
    .filter((r) => r.scenario === scenario)
    .map((r) => `[${r.projected_debt},${r.cumulative_interest}]`)
    .join(',')

const cleared = rows
  .filter((r) => r.accounts_cleared)
  .map((r) => `(${q(r.scenario)},${r.month_index},array[${r.accounts_cleared.map(q).join(',')}]::text[])`)
  .join(',')

const i = state.input
process.stdout.write(`with v as (
  insert into public.plan_versions
    (version, effective_from, attack_fund, monthly_savings, deposit_target, baseline_debt, reason, is_current)
  values (${state.version}, ${q(i.effectiveFrom)}, ${i.attackFund}, ${i.monthlySavings},
          ${i.depositTarget}, ${version.baseline_debt}, ${q(state.reason)}, true)
  returning id, effective_from, attack_fund, monthly_savings, deposit_target
), s as (
  select 'plan'::text as scenario, ordinality - 1 as month_index,
         (e->>0)::numeric as debt, (e->>1)::numeric as interest
  from jsonb_array_elements('[${series('plan')}]'::jsonb) with ordinality as t(e, ordinality)
  union all
  select 'minimums_only', ordinality - 1,
         (e->>0)::numeric, (e->>1)::numeric
  from jsonb_array_elements('[${series('minimums_only')}]'::jsonb) with ordinality as t(e, ordinality)
), c(scenario, month_index, names) as (values ${cleared})
insert into public.plan_projections
  (plan_version_id, scenario, month_index, projected_on, projected_debt,
   cumulative_interest, projected_savings, projected_net_worth, accounts_cleared)
select v.id, s.scenario, s.month_index,
       (v.effective_from + (s.month_index || ' months')::interval)::date,
       s.debt,
       s.interest,
       -- The plan makes the monthly deposit and stops at the target; the
       -- counterfactual makes none, because the deposit is part of the plan it
       -- is not following.
       case when s.scenario = 'plan'
            then least(${i.openingSavings} + v.monthly_savings * s.month_index, v.deposit_target)
            else ${i.openingSavings} end,
       ${i.assets} + ${i.otherCash}
         + case when s.scenario = 'plan'
                then least(${i.openingSavings} + v.monthly_savings * s.month_index, v.deposit_target)
                else ${i.openingSavings} end
         - s.debt,
       c.names
from v cross join s
left join c on c.scenario = s.scenario and c.month_index = s.month_index;
`)

console.error(`${rows.length} rows · plan ${summary.planMonths}mo $${summary.planInterest} · minimums ${summary.minimumsMonths}mo $${summary.minimumsInterest} · saves $${summary.interestSaved}`)
