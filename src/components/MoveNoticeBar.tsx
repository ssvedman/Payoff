import { useEffect } from 'react'
import { bucketLabel, type MoveNotice } from './Recategorizer'

/**
 * Says where a transaction went after it was relabelled.
 *
 * Both screens that offer relabelling show a subset of transactions — Activity
 * by bucket chip, Month by opened bucket — so a successful edit routinely
 * removes the row from the list it was edited in. On 2026-09-15 that was
 * reported as "I moved a Walmart transaction from optional to fixed and it
 * disappeared". The row was intact; only the confirmation was missing.
 *
 * `leftView` is the caller's judgement, because only the caller knows what it is
 * currently filtering on.
 */
export default function MoveNoticeBar({
  notice,
  leftView,
  onDismiss,
}: {
  notice: MoveNotice | null
  leftView: boolean
  onDismiss: () => void
}) {
  // Clears itself so it never becomes furniture, but long enough to be read.
  useEffect(() => {
    if (!notice) return
    const t = window.setTimeout(onDismiss, 9000)
    return () => window.clearTimeout(t)
  }, [notice, onDismiss])

  if (!notice) return null

  const target = notice.lineName
    ? `${bucketLabel(notice.to)} · ${notice.lineName}`
    : bucketLabel(notice.to)

  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '9px 11px',
        marginBottom: 12,
        borderRadius: 'var(--r-control)',
        background: 'var(--green-bg)',
        color: 'var(--green-tx)',
        lineHeight: 1.45,
      }}
    >
      <div style={{ flex: 1, fontSize: 12 }}>
        <strong>{notice.name}</strong> {notice.from ? 'moved to' : 'saved under'} {target}.
        {leftView && notice.from ? ` It is no longer in ${bucketLabel(notice.from)}, so it has left this list.` : ''}
        {notice.alsoUpdated > 0
          ? ` ${notice.alsoUpdated} other charge${notice.alsoUpdated === 1 ? '' : 's'} from this merchant moved too.`
          : ''}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{
          border: 'none',
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          fontSize: 14,
          lineHeight: 1,
          padding: 2,
        }}
      >
        ×
      </button>
    </div>
  )
}
