import { useMemo, useState } from 'react'
import { useData, type Transaction } from '../lib/data'
import { moneyCents, accountDescriptor, dayHeading } from '../lib/format'
import Recategorizer, { bucketStyle, type MoveNotice } from './Recategorizer'

/**
 * Activity rolled up, rather than listed.
 *
 * A chronological ledger answers "what happened", which is the wrong question
 * when something looks off. A superstore in this household had forty-five
 * charges worth nearly three thousand dollars filed under general merchandise
 * instead of groceries, and nothing in a day-by-day list would ever have made
 * that visible — each row looked unremarkable, and the pattern was the problem.
 *
 * Every group sorts by total, largest first, because the whole purpose is to put
 * the biggest thing at the top.
 */

export type GroupBy = 'merchant' | 'line' | 'account'

export const GROUPINGS: { key: GroupBy; label: string }[] = [
  { key: 'merchant', label: 'Merchant' },
  { key: 'line', label: 'Category' },
  { key: 'account', label: 'Account' },
]

interface Group {
  key: string
  label: string
  rows: Transaction[]
  total: number
  /** Present only when every row in the group agrees, so a mixed group says so. */
  bucket: string | null
}

export default function GroupedActivity({
  rows,
  groupBy,
  onChanged,
}: {
  rows: Transaction[]
  groupBy: GroupBy
  onChanged: (notice?: MoveNotice) => void | Promise<void>
}) {
  const { accounts, budgetLines } = useData()
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)

  const groups = useMemo<Group[]>(() => {
    const accountName = new Map(accounts.map((a) => [a.id, accountDescriptor(a)]))
    const lineName = new Map(budgetLines.map((l) => [l.id, l.line_name]))

    const map = new Map<string, Group>()
    for (const t of rows) {
      let key: string
      let label: string

      if (groupBy === 'merchant') {
        // The merchant name where the bank gives one, the raw descriptor
        // otherwise — the same fallback the categorizer's rules are keyed on, so
        // what is grouped here matches what a rule would catch.
        label = (t.merchant_name ?? t.name ?? '').trim() || 'Unnamed'
        key = label.toLowerCase()
      } else if (groupBy === 'line') {
        label = t.budget_line_id ? (lineName.get(t.budget_line_id) ?? 'Unknown line') : 'No category'
        key = t.budget_line_id ?? '__none__'
      } else {
        label = accountName.get(t.account_id) ?? 'Unlinked account'
        key = t.account_id
      }

      const g = map.get(key) ?? { key, label, rows: [], total: 0, bucket: t.bucket }
      g.rows.push(t)
      g.total += t.amount
      if (g.bucket !== t.bucket) g.bucket = null
      map.set(key, g)
    }

    for (const g of map.values()) g.rows.sort((a, b) => b.amount - a.amount)
    return [...map.values()].sort((a, b) => b.total - a.total)
  }, [rows, groupBy, accounts, budgetLines])

  if (groups.length === 0) {
    return (
      <div className="sm muted" style={{ textAlign: 'center', padding: '34px 0' }}>
        Nothing to group.
      </div>
    )
  }

  return (
    <div>
      {groups.map((g) => {
        const open = openKey === g.key
        const pill = g.bucket ? bucketStyle(g.bucket as never) : null
        return (
          <div key={g.key} style={{ borderBottom: '1px solid var(--line)' }}>
            <button
              type="button"
              onClick={() => {
                setOpenKey(open ? null : g.key)
                setEditing(null)
              }}
              aria-expanded={open}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 10,
                padding: '10px 0',
                background: 'none',
                border: 'none',
                font: 'inherit',
                color: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div className="sm" style={{ fontWeight: 600 }}>
                  {g.label}
                </div>
                <div className="tiny muted tnum">
                  {g.rows.length} {g.rows.length === 1 ? 'transaction' : 'transactions'}
                  {/* A group whose rows disagree is worth flagging: it is usually
                      a merchant doing two different jobs, which is exactly when a
                      vendor-wide rule would be the wrong tool. */}
                  {!g.bucket && ' · mixed labels'}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexShrink: 0 }}>
                {pill && (
                  <span className="pill" style={{ background: pill.bg, color: pill.tx }}>
                    {pill.label}
                  </span>
                )}
                <span
                  className="tnum sm"
                  style={{ fontWeight: 700, color: g.total < 0 ? 'var(--green)' : undefined }}
                >
                  {moneyCents(g.total)}
                </span>
              </div>
            </button>

            {open && (
              <div style={{ paddingBottom: 10 }}>
                {g.rows.map((t) => (
                  <div key={t.id} style={{ borderTop: '1px solid var(--line)', padding: '7px 0' }}>
                    <button
                      type="button"
                      onClick={() => setEditing(editing === t.id ? null : t.id)}
                      aria-expanded={editing === t.id}
                      style={{
                        width: '100%',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'baseline',
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
                        <div className="tiny" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {t.name}
                        </div>
                        <div className="tiny muted tnum">{dayHeading(t.posted_on)}</div>
                      </div>
                      <span
                        className="tnum tiny"
                        style={{ flexShrink: 0, color: t.amount < 0 ? 'var(--green)' : undefined }}
                      >
                        {moneyCents(t.amount)}
                      </span>
                    </button>

                    {editing === t.id && (
                      <div style={{ marginTop: 8 }}>
                        <Recategorizer
                          transaction={t}
                          loaded={rows}
                          onDone={async (n) => {
                            setEditing(null)
                            await onChanged(n)
                          }}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
