import { useEffect, useMemo, useState } from 'react'
import { selectAllPages, supabase } from '../lib/supabase'
import { isBusinessTxn } from '../lib/data'
import { isoDate, money, MONTH_NAMES } from '../lib/format'

/**
 * Optional spending over the six months ending at the month on screen.
 *
 * This is what survives of the old /history page on /spending: a month's bars
 * say whether this month is going well, and only a run of months says whether
 * that is normal. History's own charts were about balances, not spending, and
 * they belong on Progress; the question this answers — "is $1,044 a lot?" — has
 * no answer on a page showing one month.
 *
 * The five earlier months are fetched here. The month on screen is NOT: its
 * figure is handed in from the page, which has already totalled it from the
 * rows /spending is showing. Two sources for the same bar is how the last
 * column ends up disagreeing with the bucket bar directly above it after a
 * transaction is relabelled.
 */

interface Row {
  posted_on: string
  amount: number | string | null
  bucket: string
  account_id: string
}

interface Slot {
  /** First day of the month. */
  date: Date
  label: string
  spent: number
  /**
   * Whether anything at all is recorded for that month. A month with no rows is
   * not a month that spent nothing — the banks hand over a fixed window at link
   * time and there is nothing before it — so it is drawn as a gap rather than as
   * a floor-level bar reading $0.
   */
  recorded: boolean
}

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0))

/** How many months the chart shows, the month on screen included. */
const SPAN = 6

export default function SpendingSixMonths({
  anchor,
  businessAccountIds,
  target,
  currentSpent,
  currentRecorded,
  inProgress,
}: {
  /** First day of the month on screen. */
  anchor: Date
  businessAccountIds: Set<string>
  /** The optional target as it stands today, drawn as the dashed line. */
  target: number
  /** Optional spend for the month on screen, totalled by the page. */
  currentSpent: number
  /** Whether the month on screen has any transactions at all. */
  currentRecorded: boolean
  /** The month on screen is the live calendar month, so its bar is incomplete. */
  inProgress: boolean
}) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The five months BEFORE the anchor. The anchor's own figure is a prop.
  const bounds = useMemo(() => {
    const from = new Date(anchor.getFullYear(), anchor.getMonth() - (SPAN - 1), 1)
    const to = new Date(anchor.getFullYear(), anchor.getMonth(), 0)
    return { from: isoDate(from), to: isoDate(to) }
  }, [anchor])

  useEffect(() => {
    let active = true
    setRows(null)
    setError(null)
    void (async () => {
      // Every bucket, not just optional. A month with no optional spend and a
      // month with no record at all are different statements, and filtering to
      // optional in the query makes them indistinguishable here.
      const { data, error: err } = await selectAllPages<Row>((from, to) =>
        supabase
          .from('transactions')
          .select('posted_on, amount, bucket, account_id')
          .gte('posted_on', bounds.from)
          .lte('posted_on', bounds.to)
          // posted_on alone is not a total order — a day holds many rows, and a
          // page boundary inside a tied group drops rows or repeats them. id
          // makes the sort key unique, which is what .range() paging requires.
          .order('posted_on')
          .order('id')
          .range(from, to),
      )
      if (!active) return
      if (err) {
        setError(err)
        setRows([])
        return
      }
      setRows(data)
    })()
    return () => {
      active = false
    }
  }, [bounds])

  const slots: Slot[] = useMemo(() => {
    const spent = new Map<string, number>()
    const seen = new Set<string>()
    for (const r of rows ?? []) {
      // Business money is not household spending. The test is the account's
      // is_business flag, carried here as the id set, never the owner.
      if (isBusinessTxn(r, businessAccountIds)) continue
      const key = r.posted_on.slice(0, 7)
      seen.add(key)
      if (r.bucket !== 'optional') continue
      spent.set(key, (spent.get(key) ?? 0) + num(r.amount))
    }

    return Array.from({ length: SPAN }, (_, i) => {
      const date = new Date(anchor.getFullYear(), anchor.getMonth() - (SPAN - 1) + i, 1)
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      const isAnchor = i === SPAN - 1
      return {
        date,
        label: MONTH_NAMES[date.getMonth()].slice(0, 3),
        spent: isAnchor ? currentSpent : (spent.get(key) ?? 0),
        recorded: isAnchor ? currentRecorded : seen.has(key),
      }
    })
  }, [rows, businessAccountIds, anchor, currentSpent, currentRecorded])

  if (rows === null) {
    return (
      <div className="box" aria-busy="true" aria-label="Loading the last six months">
        <div className="skeleton" style={{ width: 108, height: 12, marginBottom: 12 }} />
        <div className="skeleton" style={{ height: 96 }} />
      </div>
    )
  }

  // Geometry, in viewBox units. The plot floor is y=80 and the tallest bar tops
  // out at y=6, leaving the labels their own band beneath.
  const FLOOR = 80
  const CEIL = 6
  const H = FLOOR - CEIL
  const BAR_W = 34
  const STEP = 50
  const X0 = 12

  const tallest = Math.max(target, ...slots.map((s) => s.spent))
  // A little headroom, so the tallest bar is not flush with the top edge and the
  // dashed target line is never drawn off the chart.
  const top = tallest > 0 ? tallest * 1.12 : 1
  const y = (v: number) => FLOOR - (Math.max(0, v) / top) * H
  const targetY = y(target)

  const described = slots
    .map((s) => (s.recorded ? `${s.label} ${money(s.spent)}` : `${s.label} not recorded`))
    .join(', ')

  return (
    <div className="box">
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 7 }}>Last six months</div>
      <svg
        viewBox="0 0 320 96"
        style={{ width: '100%', display: 'block' }}
        role="img"
        aria-label={`Optional spending, last six months: ${described}. Target ${money(target)}.`}
      >
        {slots.map((s, i) => {
          if (!s.recorded) {
            return (
              <text
                key={i}
                x={X0 + i * STEP + BAR_W / 2}
                y={FLOOR - 3}
                fontSize="8"
                fill="var(--steel)"
                textAnchor="middle"
              >
                —
              </text>
            )
          }
          const isAnchor = i === SPAN - 1
          /**
           * Ink for a month still running: it has not deviated from anything
           * yet, and colouring a part-month red judges it against a target it
           * has not reached the end of. Finished months are green under target
           * and red over it, which is the same green-is-on-plan, red-is-a-
           * deviation rule the bars above use.
           */
          const fill =
            isAnchor && inProgress
              ? 'var(--ink)'
              : // No target budgeted is nothing to be over or under, so the bar
                // states the figure and passes no verdict on it.
                target <= 0
                ? 'var(--steel)'
                : s.spent > target
                  ? 'var(--red)'
                  : 'var(--green)'
          const barY = y(s.spent)
          return (
            <rect
              key={i}
              x={X0 + i * STEP}
              y={barY}
              width={BAR_W}
              height={Math.max(1, FLOOR - barY)}
              fill={fill}
              opacity={isAnchor ? 1 : 0.8}
            />
          )
        })}

        {target > 0 && (
          <line
            x1="6"
            y1={targetY}
            x2="314"
            y2={targetY}
            stroke="var(--steel)"
            strokeDasharray="3 3"
          />
        )}

        {slots.map((s, i) => (
          <text
            key={`l${i}`}
            x={X0 + i * STEP + BAR_W / 2}
            y="93"
            fontSize="8"
            fill={i === SPAN - 1 ? 'var(--ink)' : 'var(--steel)'}
            fontWeight={i === SPAN - 1 ? 700 : 400}
            textAnchor="middle"
          >
            {s.label}
          </text>
        ))}
      </svg>

      {/*
        Said plainly: budget lines carry one target, not a target per month, so
        the dashed line is today's figure laid across months it was not
        necessarily the target for.
      */}
      <div className="rule">
        Optional spending, household only.
        {target > 0
          ? ` The dashed line is the ${money(target)} target as it stands today, drawn across every month.`
          : ' No optional target is budgeted, so there is no line to draw.'}
        {error && ` Earlier months could not be loaded. ${error}`}
      </div>
    </div>
  )
}
