import { useEffect, useState } from 'react'
import { money } from '../lib/format'

/**
 * The order accounts come off, one row per MONTH in which something clears.
 *
 * Desktop gets a real table and a phone gets rows with the amount flush right.
 * The two are different markup rather than one table taught to reflow, because
 * a four-column table at 340px either scrolls sideways or wraps every cell, and
 * both of those are worse than a row.
 */

export interface ClearingGroup {
  /** 1-based position in the clearing order, not the month number. */
  n: number
  /** Every account clearing in that month, named the way the app names them. */
  names: string[]
  /**
   * What is owed on those accounts TODAY, or null when a stored name could not
   * be matched to a live account. A partial sum printed as a total would
   * understate the row by exactly the account that went missing, so it is not
   * printed at all.
   */
  balance: number | null
  monthIndex: number
  /** "Nov 26". */
  clears: string
  /** True for the month the last debt goes. */
  isLast: boolean
  /** True for the month the current payoff target clears. */
  isTarget: boolean
}

/**
 * Whether there is room for a table. Matched to the 1024px breakpoint the
 * stylesheet uses, so the layout never disagrees with itself about which
 * screen this is.
 */
export function useWideScreen(): boolean {
  const [wide, setWide] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches,
  )

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const apply = () => setWide(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  return wide
}

/**
 * The position marker.
 *
 * No amber. Progress names no target account as a heading, and amber is
 * reserved for the current payoff target so tightly that spending it on a
 * position number in a table would cost more than it buys. The target's group
 * is marked by weight instead: ink on the neutral pill, which reads as "this
 * one" without claiming the reserved colour.
 */
function Marker({ group }: { group: ClearingGroup }) {
  const style = group.isTarget
    ? { background: 'var(--neutral-bg)', color: 'var(--ink)', fontWeight: 800 }
    : group.isLast
      ? { background: 'var(--green-bg)', color: 'var(--green-tx)' }
      : { background: 'var(--card)', color: 'var(--steel)' }
  return (
    <span className="pill tnum" style={{ ...style, cursor: 'default' }}>
      {group.n}
    </span>
  )
}

export default function ProgressClearingOrder({ groups }: { groups: ClearingGroup[] }) {
  const wide = useWideScreen()

  if (groups.length === 0) {
    return (
      <div className="sm muted" style={{ padding: '10px 0' }}>
        No account clears under this plan version.
      </div>
    )
  }

  if (!wide) {
    return (
      <div>
        {groups.map((g) => (
          <div className="row" key={g.monthIndex}>
            <Marker group={g} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="sm" style={{ fontWeight: 600 }}>
                {g.names.join(' · ')}
              </span>
              <span className="tiny muted tnum" style={{ display: 'block' }}>
                month {g.monthIndex}
              </span>
            </span>
            <span style={{ textAlign: 'right' }}>
              <span className="tnum sm" style={{ fontWeight: 600, display: 'block' }}>
                {g.balance === null ? '—' : money(g.balance)}
              </span>
              <span
                className={`tnum tiny ${g.isLast ? 'is-good' : 'muted'}`}
                style={{ fontWeight: g.isLast ? 700 : 400 }}
              >
                {g.clears}
              </span>
            </span>
          </div>
        ))}
      </div>
    )
  }

  return (
    <table className="tbl">
      <thead>
        <tr>
          <th style={{ width: 34 }} />
          <th>Accounts</th>
          <th className="num">Balance</th>
          <th className="num" style={{ width: 140 }}>
            Clears
          </th>
        </tr>
      </thead>
      <tbody>
        {groups.map((g) => (
          <tr key={g.monthIndex}>
            <td>
              <Marker group={g} />
            </td>
            <td style={{ fontWeight: g.isLast ? 700 : 400 }}>{g.names.join(' · ')}</td>
            <td className="num" style={{ fontWeight: g.isLast ? 700 : 400 }}>
              {g.balance === null ? '—' : money(g.balance)}
            </td>
            <td
              className={`num ${g.isLast ? 'is-good' : 'muted'}`}
              style={{ fontWeight: g.isLast ? 700 : 400 }}
            >
              month {g.monthIndex} &middot; {g.clears}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
