import { useCallback, useMemo, useState } from 'react'
import Bar from '../components/Bar'
import SplitBar from '../components/SplitBar'
import LineBars from '../components/LineBars'
import { useData, useMonthTotals, type Transaction } from '../lib/data'
import { money, moneyCents, MONTH_NAMES, accountDescriptor, dayHeading, ownerLabel } from '../lib/format'
import Recategorizer, { type MoveNotice } from '../components/Recategorizer'
import MoveNoticeBar from '../components/MoveNoticeBar'

/**
 * /month — bucket progress for the current calendar month, the optional bucket
 * broken down by budget line, and a factual comparison against the plan.
 *
 * Everything here is driven by this month's transactions. The seeded database has
 * none yet, so every figure legitimately reads $0 — the page states that plainly
 * rather than implying anything went wrong.
 *
 * Color rules (BUILD.md §8): amber is the current target and appears nowhere on
 * this screen. Green is on plan, red is a deviation from plan, steel is everything
 * else. A figure that is merely incomplete part-way through the month is steel,
 * not red — nothing has deviated yet.
 */

const CATCH_ALL = 'everything else'

/**
 * The day after which the attack payment being absent counts as a deviation
 * rather than as a month still in progress — BUILD.md §6, `attack_missing`.
 */
const ATTACK_DUE_DAY = 15

/** Whole-dollar difference, never negative. */
const gap = (a: number, b: number) => Math.max(0, a - b)

export default function Month() {
  // `transactions` is the HOUSEHOLD's — the data layer has already removed
  // anything on a business account, so every total on this page is household
  // money by construction rather than by each sum remembering to exclude it.
  const { loading, error, transactions, allTransactions, budgetLines, plan, accounts, refresh } =
    useData()
  const totals = useMonthTotals()

  /**
   * Which bucket is opened up.
   *
   * A bar says a bucket is at 155% of its target and stops there — the one
   * question it provokes is "on what?", and answering it meant leaving for
   * /activity, filtering, and reading back a figure that was no longer on screen.
   * Opening it in place keeps the total next to the things that make it up.
   */
  const [openBucket, setOpenBucket] = useState<string | null>(null)

  const nameOf = useMemo(() => {
    const byId = new Map(accounts.map((a) => [a.id, accountDescriptor(a)]))
    return (id: string) => byId.get(id) ?? 'Unlinked account'
  }, [accounts])

  /**
   * Optional spend by whose account it went out of. The two people come from the
   * accounts themselves rather than from code, so their names never enter the
   * repository. A joint account belongs to neither side of the split, so its
   * spend is reported beside the bar instead of being divided by guesswork.
   */
  const optionalByOwner = useMemo(() => {
    const ownerOf = new Map(accounts.map((a) => [a.id, a.owner]))
    const people = [...new Set(accounts.map((a) => a.owner).filter((o) => o !== 'joint'))].sort()
    const spent = new Map<string, number>()
    for (const t of transactions) {
      if (t.bucket !== 'optional') continue
      const o = ownerOf.get(t.account_id) ?? 'joint'
      spent.set(o, (spent.get(o) ?? 0) + t.amount)
    }
    return { people, spent, joint: spent.get('joint') ?? 0 }
  }, [accounts, transactions])

  /** Largest first: the rows worth looking at are the ones moving the total. */
  const rowsIn = useMemo(() => {
    const groups = new Map<string, Transaction[]>()
    for (const t of transactions) {
      const list = groups.get(t.bucket) ?? []
      list.push(t)
      groups.set(t.bucket, list)
    }
    for (const list of groups.values()) list.sort((a, b) => b.amount - a.amount)
    return groups
  }, [transactions])

  const today = new Date()
  const day = today.getDate()
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
  const daysLeft = daysInMonth - day
  // daysInMonth is 28–31, so this never divides by zero and is always > 0.
  const elapsed = day / daysInMonth

  const attackTarget = plan?.attack_fund ?? 0
  const savingsTarget = plan?.monthly_savings ?? 0

  const optionalSpent = totals.bucketSpent('optional')
  const optionalTarget = totals.bucketTarget('optional')
  const fixedSpent = totals.bucketSpent('fixed')
  const fixedTarget = totals.bucketTarget('fixed')
  const attackSpent = totals.bucketSpent('attack')
  const savingsSpent = totals.bucketSpent('savings')

  const spentTotal = fixedSpent + optionalSpent + attackSpent + savingsSpent
  const income = totals.income

  /**
   * Per-line optional spend, read from each transaction's budget_line_id — set by
   * the categoriser from the Plaid category, or pinned by a merchant rule when
   * someone corrects one in /activity. Optional spend with no line yet collects in
   * the catch-all, so the lines always sum to the bucket.
   */
  const linesIn = useMemo(() => {
    const build = (bucket: 'optional' | 'fixed') => {
    const lines = budgetLines.filter((l) => l.bucket === bucket)
    const spent = new Map<string, number>(lines.map((l) => [l.id, 0]))
    const catchAll = lines.find((l) => l.line_name.trim().toLowerCase() === CATCH_ALL)

    for (const t of transactions) {
      if (t.bucket !== bucket) continue
      // A transaction now carries its line explicitly. Anything not yet assigned
      // — a merchant no rule covers — collects in the catch-all rather than being
      // dropped, so the lines always sum to the bucket.
      // An id that is not an OPTIONAL line — a row filed against a fixed line and
      // later re-bucketed, say — must still land somewhere, or the rows below sum
      // to less than the bar above them and the comment's promise is broken.
      const lineId =
        t.budget_line_id && spent.has(t.budget_line_id) ? t.budget_line_id : catchAll?.id
      // FIXED has no catch-all, so an unassigned fixed charge has nowhere to go.
      // It is counted in `unassigned` below rather than dropped, because a row of
      // lines that quietly sums to less than the bar above it is worse than one
      // that admits what it could not place.
      if (!lineId) continue
      spent.set(lineId, (spent.get(lineId) ?? 0) + t.amount)
    }

    const placed = lines.map((l) => ({ ...l, spent: spent.get(l.id) ?? 0 }))
    const totalPlaced = placed.reduce((sum, l) => sum + l.spent, 0)
    const bucketTotal = transactions
      .filter((t) => t.bucket === bucket)
      .reduce((sum, t) => sum + t.amount, 0)

    return { lines: placed, unassigned: Math.round((bucketTotal - totalPlaced) * 100) / 100 }
    }

    return { optional: build('optional'), fixed: build('fixed') }
  }, [budgetLines, transactions])


  // First load only — see the note on Home. A background refetch must not replace
  // figures already on screen with placeholders.
  if (loading && budgetLines.length === 0) {
    return (
      <div className="page" aria-busy="true" aria-label="Loading this month">
        <div
          className="skeleton"
          style={{ width: 132, height: 20, marginBottom: 10 }}
          aria-hidden="true"
        />
        <div
          className="skeleton"
          style={{ width: 168, height: 12, marginBottom: 24 }}
          aria-hidden="true"
        />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ marginBottom: 17 }} aria-hidden="true">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginBottom: 7,
              }}
            >
              <div className="skeleton" style={{ width: 84, height: 12 }} />
              <div className="skeleton" style={{ width: 96, height: 12 }} />
            </div>
            <div className="skeleton" style={{ height: 7, borderRadius: 4 }} />
          </div>
        ))}
        <div
          className="skeleton"
          style={{ width: 120, height: 12, margin: '26px 0 14px' }}
          aria-hidden="true"
        />
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="skeleton"
            style={{ height: 12, marginBottom: 18, width: `${92 - i * 6}%` }}
            aria-hidden="true"
          />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="page">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
          <span style={{ fontWeight: 700, fontSize: 20 }}>{MONTH_NAMES[today.getMonth()]}</span>
          <span className="tnum tiny muted">
            day {day} of {daysInMonth}
          </span>
        </div>
        <div className="sm muted">This month could not be loaded. {error}</div>
      </div>
    )
  }

  // Optional is judged against pace, so an on-track month reads neutral all the way.
  // BUILD.md §7 defines the deviation as the optional bucket running over target pace.
  const pace = optionalTarget * elapsed
  const overTarget = optionalSpent > optionalTarget
  const offPace = optionalSpent > pace
  const optionalColor = offPace ? 'var(--red)' : 'var(--steel)'

  const attackMet = attackTarget > 0 && attackSpent >= attackTarget
  const savingsMet = savingsTarget > 0 && savingsSpent >= savingsTarget

  // Projected month-end optional spend at the current rate. elapsed is always > 0.
  const projectedOptional = optionalSpent / elapsed

  // The planned monthly outlay income has to cover.
  const plannedOutlay = fixedTarget + optionalTarget + attackTarget + savingsTarget
  const hasTransactions = transactions.length > 0
  /** How much of the month's activity the budget deliberately ignores. */
  const businessExcluded = allTransactions.length - transactions.length
  const monthComplete = daysLeft === 0

  /**
   * The right-hand note on a plan row. Green when the figure meets the plan, red
   * when falling short is a deviation at this point in the month, steel while the
   * month still has time to run.
   */
  const verdict = (met: boolean, shortText: string, isDeviation: boolean) => {
    if (!hasTransactions) return <span className="tnum tiny muted">nothing recorded</span>
    if (met) {
      return (
        <span className="tnum tiny" style={{ color: 'var(--green)' }}>
          on plan
        </span>
      )
    }
    return (
      <span
        className={isDeviation ? 'tnum tiny' : 'tnum tiny muted'}
        style={isDeviation ? { color: 'var(--red)' } : undefined}
      >
        {shortText}
      </span>
    )
  }

  const cell = { border: 'none', padding: '4px 0' } as const
  const cellRight = { ...cell, textAlign: 'right' as const }

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 20 }}>{MONTH_NAMES[today.getMonth()]}</span>
        <span className="tnum tiny muted">
          day {day} of {daysInMonth}
        </span>
      </div>

      <div className="tnum sm muted" style={{ marginBottom: 20 }}>
        {income > 0 ? `${money(spentTotal)} spent of ${money(income)} in` : `${money(spentTotal)} spent`}
      </div>
      <div className="tiny muted" style={{ marginBottom: 14 }}>
        Tap a bucket to see what is in it, then a transaction to relabel it.
        {/* Said plainly, because a figure that quietly disagrees with the bank
            reads as a fault. The rows are still on Activity, behind its own
            show-business control. */}
        {businessExcluded > 0 &&
          ` ${businessExcluded} business ${businessExcluded === 1 ? 'transaction is' : 'transactions are'} not counted here.`}
      </div>

      {/* Optional */}
      <div style={{ marginBottom: 17 }}>
        <BucketHeader
          label="Optional"
          count={(rowsIn.get('optional') ?? []).length}
          open={openBucket === 'optional'}
          onToggle={() => setOpenBucket((c) => (c === 'optional' ? null : 'optional'))}
          right={
            <span
              className={offPace ? 'tnum' : 'tnum muted'}
              style={offPace ? { color: 'var(--red)', fontWeight: 700 } : undefined}
            >
              {money(optionalSpent)} / {money(optionalTarget)}
            </span>
          }
        />
        <Bar pct={optionalTarget > 0 ? optionalSpent / optionalTarget : 0} color={optionalColor} />
        <div className="tnum tiny muted" style={{ marginTop: 4 }}>
          {overTarget
            ? `${money(optionalSpent - optionalTarget)} over, ${daysLeft} days remaining`
            : `${money(optionalTarget - optionalSpent)} left, ${daysLeft} days remaining`}
        </div>
        {optionalByOwner.people.length === 2 && (
          <>
            <SplitBar
              left={{
                label: ownerLabel(optionalByOwner.people[0]),
                amount: optionalByOwner.spent.get(optionalByOwner.people[0]) ?? 0,
              }}
              right={{
                label: ownerLabel(optionalByOwner.people[1]),
                amount: optionalByOwner.spent.get(optionalByOwner.people[1]) ?? 0,
              }}
            />
            {Math.abs(optionalByOwner.joint) >= 0.01 && (
              <div className="tnum tiny muted" style={{ marginTop: 4 }}>
                {money(optionalByOwner.joint)} on joint accounts, not split
              </div>
            )}
          </>
        )}
        {openBucket === 'optional' && (
          <BucketRows
            rows={rowsIn.get('optional') ?? []}
            nameOf={nameOf}
            emptyNote="Nothing discretionary this month."
            onChanged={refresh}
          />
        )}
      </div>

      {/* Fixed */}
      <div style={{ marginBottom: 17 }}>
        <BucketHeader
          label="Fixed"
          count={(rowsIn.get('fixed') ?? []).length}
          open={openBucket === 'fixed'}
          onToggle={() => setOpenBucket((c) => (c === 'fixed' ? null : 'fixed'))}
          right={
            <span className="tnum muted">
              {money(fixedSpent)} / {money(fixedTarget)}
            </span>
          }
        />
        <Bar pct={fixedTarget > 0 ? fixedSpent / fixedTarget : 0} color="var(--steel)" />
        {openBucket === 'fixed' && (
          <BucketRows
            rows={rowsIn.get('fixed') ?? []}
            nameOf={nameOf}
            emptyNote="Nothing committed has gone out yet this month."
            onChanged={refresh}
          />
        )}
      </div>

      {/* Attack fund */}
      <div style={{ marginBottom: 17 }}>
        <BucketHeader
          label="Attack fund"
          count={(rowsIn.get('attack') ?? []).length}
          open={openBucket === 'attack'}
          onToggle={() => setOpenBucket((c) => (c === 'attack' ? null : 'attack'))}
          right={
            <span
              className={attackMet ? 'tnum' : 'tnum muted'}
              style={attackMet ? { color: 'var(--green)', fontWeight: 700 } : undefined}
            >
              {money(attackSpent)} sent
            </span>
          }
        />
        <Bar
          pct={attackTarget > 0 ? attackSpent / attackTarget : 0}
          color={attackMet ? 'var(--green)' : 'var(--steel)'}
        />
        {hasTransactions && !attackMet && attackTarget > 0 && (
          <div className="tnum tiny muted" style={{ marginTop: 4 }}>
            {money(gap(attackTarget, attackSpent))} short of {money(attackTarget)}
          </div>
        )}
        {openBucket === 'attack' && (
          <BucketRows
            rows={rowsIn.get('attack') ?? []}
            nameOf={nameOf}
            emptyNote="Nothing has reached the current target this month."
            onChanged={refresh}
          />
        )}
      </div>

      {/* Savings */}
      <div>
        <BucketHeader
          label="Savings"
          count={(rowsIn.get('savings') ?? []).length}
          open={openBucket === 'savings'}
          onToggle={() => setOpenBucket((c) => (c === 'savings' ? null : 'savings'))}
          right={
            <span
              className={savingsMet ? 'tnum' : 'tnum muted'}
              style={savingsMet ? { color: 'var(--green)', fontWeight: 700 } : undefined}
            >
              {money(savingsSpent)} sent
            </span>
          }
        />
        <Bar
          pct={savingsTarget > 0 ? savingsSpent / savingsTarget : 0}
          color={savingsMet ? 'var(--green)' : 'var(--steel)'}
        />
        {hasTransactions && !savingsMet && savingsTarget > 0 && (
          <div className="tnum tiny muted" style={{ marginTop: 4 }}>
            {money(gap(savingsTarget, savingsSpent))} short of {money(savingsTarget)}
          </div>
        )}
        {openBucket === 'savings' && (
          <BucketRows
            rows={rowsIn.get('savings') ?? []}
            nameOf={nameOf}
            emptyNote="Nothing has moved to savings this month."
            onChanged={refresh}
          />
        )}
      </div>

      <div className="sect">Optional, by line</div>
      <LineBars
        lines={linesIn.optional.lines}
        unassigned={linesIn.optional.unassigned}
        unassignedNote="not assigned to a line"
      />

      {/*
        Fixed had no breakdown at all — ten lines and more than seven thousand a
        month behind a single bar. A grocery budget you cannot see is a grocery
        budget you cannot keep.
      */}
      <div className="sect">Fixed, by line</div>
      <ByLine
        group={linesIn.fixed}
        unassignedNote="not assigned to a line"
      />
      {!hasTransactions && (
        <div className="tiny muted" style={{ marginTop: 8 }}>
          No transactions recorded this month.
        </div>
      )}

      <div className="sect">Compared with the plan</div>
      <div className="card-panel">
        <table style={{ margin: 0 }}>
          <tbody>
            <tr>
              <td className="sm" style={cell}>
                Income
              </td>
              <td className="tnum sm" style={cellRight}>
                {money(income)}
              </td>
              <td style={cellRight}>
                {verdict(
                  income >= plannedOutlay,
                  `${money(gap(plannedOutlay, income))} short`,
                  monthComplete,
                )}
              </td>
            </tr>
            <tr>
              <td className="sm" style={cell}>
                Attack fund
              </td>
              <td className="tnum sm" style={cellRight}>
                {money(attackSpent)}
              </td>
              <td style={cellRight}>
                {verdict(
                  attackSpent >= attackTarget,
                  `${money(gap(attackTarget, attackSpent))} short`,
                  day > ATTACK_DUE_DAY,
                )}
              </td>
            </tr>
            <tr>
              <td className="sm" style={cell}>
                Optional
              </td>
              <td className="tnum sm" style={cellRight}>
                {money(optionalSpent)}
              </td>
              <td style={cellRight}>
                {verdict(
                  !offPace,
                  `+${money(projectedOptional - optionalTarget)} projected`,
                  true,
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

/**
 * The transactions behind one bucket's bar.
 *
 * Deliberately NOT a link to /activity: the point of opening a bucket is to see
 * what is in it while the total that prompted the question is still on screen.
 * Sorted largest first, because the rows worth looking at are the ones moving
 * the number.
 */
function BucketRows({
  rows,
  nameOf,
  emptyNote,
  onChanged,
}: {
  rows: Transaction[]
  nameOf: (id: string) => string
  emptyNote: string
  onChanged: () => void | Promise<void>
}) {
  /**
   * Which row is being relabelled. A bucket total is exactly where a
   * miscategorised charge becomes obvious — seeing it and not being able to fix
   * it is the wrong place to stop, so the same editor /activity uses opens here.
   */
  const [editing, setEditing] = useState<string | null>(null)

  /**
   * The last relabel made here.
   *
   * An opened bucket only lists its own rows, so relabelling one into a
   * different bucket removes it from this list on the next refresh — and if it
   * was the only row, the list empties. Both read as the transaction being
   * deleted unless this says otherwise.
   */
  const [notice, setNotice] = useState<MoveNotice | null>(null)
  const clearNotice = useCallback(() => setNotice(null), [])
  const banner = (
    <MoveNoticeBar notice={notice} leftView={notice?.from !== null} onDismiss={clearNotice} />
  )

  if (rows.length === 0) {
    return (
      <div style={{ padding: '9px 0 2px' }}>
        {banner}
        <div className="tiny muted">{emptyNote}</div>
      </div>
    )
  }

  const total = rows.reduce((s, t) => s + t.amount, 0)

  return (
    <div style={{ marginTop: 9, borderTop: '1px solid var(--line)' }}>
      <div style={{ paddingTop: 9 }}>{banner}</div>
      {rows.map((t) => (
        <div key={t.id} style={{ borderBottom: '1px solid var(--line)', padding: '7px 0' }}>
          <button
            type="button"
            onClick={() => setEditing((c) => (c === t.id ? null : t.id))}
            aria-expanded={editing === t.id}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 10,
              background: 'none',
              border: 'none',
              padding: 0,
              font: 'inherit',
              color: 'inherit',
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div className="sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {t.merchant_name ?? t.name}
              </div>
              <div className="tiny muted tnum">
                {dayHeading(t.posted_on)} · {nameOf(t.account_id)}
              </div>
            </div>
            {/* Money in is shown negative and green, matching /activity. */}
            <div
              className="tnum sm"
              style={{ flexShrink: 0, color: t.amount < 0 ? 'var(--green)' : undefined }}
            >
              {moneyCents(t.amount)}
            </div>
          </button>

          {editing === t.id && (
            <div style={{ marginTop: 9 }}>
              <Recategorizer
                transaction={t}
                loaded={rows}
                onDone={async (n) => {
                  setEditing(null)
                  setNotice(n ?? null)
                  await onChanged()
                }}
              />
            </div>
          )}
        </div>
      ))}
      <div className="tiny muted tnum" style={{ paddingTop: 7, textAlign: 'right' }}>
        {rows.length} {rows.length === 1 ? 'transaction' : 'transactions'} · {moneyCents(total)}
      </div>
    </div>
  )
}

/** A bucket's heading, which is also the control that opens it. */
function BucketHeader({
  label,
  right,
  count,
  open,
  onToggle,
}: {
  label: string
  right: React.ReactNode
  count: number
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      style={{
        width: '100%',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: 10,
        fontSize: 14,
        marginBottom: 5,
        background: 'none',
        border: 'none',
        padding: 0,
        font: 'inherit',
        cursor: 'pointer',
        textAlign: 'left',
        color: 'inherit',
      }}
    >
      <span style={{ fontWeight: 600 }}>
        {label}
        <span className="tiny muted" style={{ fontWeight: 400 }}>
          {' '}
          {open ? '▴' : '▾'}
          {count > 0 ? ` ${count}` : ''}
        </span>
      </span>
      {right}
    </button>
  )
}

/**
 * One bucket's budget lines against what has gone to each.
 *
 * `unassigned` is shown rather than hidden. Optional has a catch-all line so it
 * is normally zero there, but fixed has none — and a table of lines that sums to
 * less than the bar above it, with no explanation, is how a category quietly
 * looks empty while the money is somewhere else entirely.
 */
function ByLine({
  group,
  unassignedNote,
}: {
  group: { lines: { id: string; line_name: string; monthly_target: number; spent: number }[]; unassigned: number }
  unassignedNote: string
}) {
  if (group.lines.length === 0) {
    return <div className="sm muted">No budget lines here.</div>
  }

  return (
    <table>
      <tbody>
        {group.lines.map((l) => (
          <tr key={l.id}>
            <td className="sm">{l.line_name}</td>
            <td className="tnum sm" style={{ textAlign: 'right' }}>
              {money(l.spent)}
            </td>
            <td className="tnum tiny muted" style={{ textAlign: 'right', width: 54 }}>
              of {money(l.monthly_target)}
            </td>
          </tr>
        ))}
        {Math.abs(group.unassigned) >= 0.01 && (
          <tr>
            <td className="sm muted">{unassignedNote}</td>
            <td className="tnum sm muted" style={{ textAlign: 'right' }}>
              {money(group.unassigned)}
            </td>
            <td />
          </tr>
        )}
      </tbody>
    </table>
  )
}
