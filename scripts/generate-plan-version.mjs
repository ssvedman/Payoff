/**
 * Generate a plan version's frozen projections — ONE SHOT, BY HAND.
 *
 * This is not wired to anything. It is not called on load, on sync, or by the
 * app at all; it exists so that generating a version is a deliberate act with a
 * reviewable diff, which is the whole point of freezing the lines.
 *
 * It reads a state file describing the world as at the plan's effective date,
 * runs the avalanche once through src/lib/planGeneration.ts — the same module
 * any future generator must use — and writes SQL to stdout. Nothing here
 * touches the database: the SQL is reviewed, then applied.
 *
 *   node scripts/generate-plan-version.mjs <state.json> > version-1.sql
 *
 * The emitted SQL refuses to run if that version already exists, so applying it
 * twice cannot rewrite a stored projection.
 */

import { build } from 'esbuild'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const statePath = process.argv[2]
if (!statePath) {
  console.error('usage: node scripts/generate-plan-version.mjs <state.json>')
  process.exit(1)
}

// The generation logic lives in TypeScript beside the app so the app's own
// simulate() is the one that runs. Bundle it rather than keeping a second copy
// in JavaScript that could quietly disagree about rounding.
const bundlePath = join(tmpdir(), `payoff-plan-gen-${process.pid}.mjs`)
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
const arr = (names) =>
  names === null ? 'null' : `array[${names.map((n) => q(n)).join(',')}]::text[]`
const money = (n) => n.toFixed(2)

const versionNo = state.version
const reason = state.reason ?? null

const values = rows
  .map(
    (r) =>
      `  (v.id, ${q(r.scenario)}, ${r.month_index}, ${q(r.projected_on)}, ` +
      `${money(r.projected_debt)}, ${money(r.cumulative_interest)}, ` +
      `${money(r.projected_savings)}, ${money(r.projected_net_worth)}, ${arr(r.accounts_cleared)})`,
  )
  .join(',\n')

const sql = `-- Plan version ${versionNo} — generated ${state.generatedOn} from the ${version.effective_from} state.
-- ${rows.length} projection rows: plan runs ${summary.planMonths} months, minimums-only ${summary.minimumsMonths}.
-- The plan saves $${summary.interestSaved.toFixed(2)} of interest and ${summary.monthsSaved} months.
--
-- DO NOT EDIT THESE ROWS. A changed plan is a new version.

begin;

-- Refuse rather than overwrite. Applying this twice is a mistake, not an update.
do $$
begin
  if exists (select 1 from public.plan_versions where version = ${versionNo}) then
    raise exception 'plan version ${versionNo} already exists — create a new version instead';
  end if;
end $$;

-- Only one version is current; any earlier one steps down first.
update public.plan_versions set is_current = false where is_current;

with v as (
  insert into public.plan_versions
    (version, effective_from, attack_fund, monthly_savings, deposit_target, baseline_debt, reason, is_current)
  values
    (${versionNo}, ${q(version.effective_from)}, ${money(version.attack_fund)}, ${money(version.monthly_savings)},
     ${money(version.deposit_target)}, ${money(version.baseline_debt)}, ${reason === null ? 'null' : q(reason)}, true)
  returning id
)
insert into public.plan_projections
  (plan_version_id, scenario, month_index, projected_on, projected_debt,
   cumulative_interest, projected_savings, projected_net_worth, accounts_cleared)
select * from (values
${values}
) as t(plan_version_id, scenario, month_index, projected_on, projected_debt,
       cumulative_interest, projected_savings, projected_net_worth, accounts_cleared);

commit;
`

process.stdout.write(sql)

console.error(`
  version        ${versionNo}
  effective from ${version.effective_from}
  baseline debt  $${money(version.baseline_debt)}
  attack fund    $${money(version.attack_fund)}

  plan           ${summary.planMonths} months, $${money(summary.planInterest)} interest${summary.planStalled ? '  ** STALLED **' : ''}
  minimums only  ${summary.minimumsMonths} months, $${money(summary.minimumsInterest)} interest${summary.minimumsStalled ? '  ** STALLED **' : ''}
  the plan saves $${money(summary.interestSaved)} and ${summary.monthsSaved} months

  ${rows.length} rows written to stdout
`)
