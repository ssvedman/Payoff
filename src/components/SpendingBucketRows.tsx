import { useCallback, useState } from 'react'
import Recategorizer, { type MoveNotice } from './Recategorizer'
import MoveNoticeBar from './MoveNoticeBar'
import { moneyCents, dayHeading } from '../lib/format'
import type { Transaction } from '../lib/data'

/**
 * The transactions behind one bucket's bar on /spending.
 *
 * Deliberately NOT a link to /activity: the point of opening a bucket is to see
 * what is in it while the total that prompted the question is still on screen.
 * Sorted largest first, because the rows worth looking at are the ones moving
 * the number.
 *
 * This moved out of the old /month page unchanged in behaviour. The redesign
 * draws the buckets as four bars and nothing else, which is right for the
 * resting state, but a bar that says a bucket is at 155% of target still
 * provokes exactly one question — "on what?" — and answering it anywhere but
 * here means leaving the page and reading back a figure that is no longer in
 * view.
 */
export default function SpendingBucketRows({
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
