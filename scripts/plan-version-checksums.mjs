/**
 * Checksums for a generated plan version, for comparing against what the
 * database actually stored.
 *
 * Generation happens here and the rows are applied over a separate connection,
 * so the two are worth reconciling rather than assuming. Summing every column
 * catches a mistyped digit anywhere in the series, which spot-checking the
 * first and last row does not.
 *
 *   node scripts/plan-version-checksums.mjs Build\ Docs/plan-v1-state.json
 */
import { build } from 'esbuild'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bp = join(tmpdir(), `payoff-checksums-${process.pid}.mjs`)
await build({ entryPoints: ['src/lib/planGeneration.ts'], bundle: true, format: 'esm', platform: 'node', outfile: bp, logLevel: 'error' })
const { generatePlan } = await import(`file://${bp}`)
const state = JSON.parse(await readFile(process.argv[2], 'utf8'))
const { rows } = generatePlan(state.input)
await rm(bp, { force: true })

const r2 = (n) => Math.round(n * 100) / 100
const sum = (rs, k) => r2(rs.reduce((s, r) => s + r[k], 0)).toFixed(2)

for (const sc of ['minimums_only', 'plan']) {
  const rs = rows.filter((r) => r.scenario === sc)
  console.log(
    sc.padEnd(14),
    'rows', String(rs.length).padStart(3),
    '| debt', sum(rs, 'projected_debt').padStart(12),
    '| interest', sum(rs, 'cumulative_interest').padStart(12),
    '| networth', sum(rs, 'projected_net_worth').padStart(12),
    '| clearing', rs.filter((r) => r.accounts_cleared).length,
    '| ends', rs[rs.length - 1].projected_on,
  )
}
