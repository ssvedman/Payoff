import { useViewMode, type ViewMode } from '../lib/viewMode'

const OPTIONS: { value: ViewMode; label: string }[] = [
  { value: 'personal', label: 'Personal' },
  { value: 'business', label: 'Business' },
]

/**
 * Personal / Business.
 *
 * Rendered in two places — a bar above the page on a phone, the top of the
 * sidebar on desktop — and CSS shows exactly one. Both read the same context, so
 * they cannot disagree; swapping them with matchMedia in JS instead would flicker
 * on first paint, because the first render happens before the query resolves.
 */
export default function ViewToggle() {
  const { mode, setMode } = useViewMode()

  return (
    <div className="seg" role="group" aria-label="View">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          className={mode === o.value ? 'seg__btn on' : 'seg__btn'}
          aria-pressed={mode === o.value}
          onClick={() => setMode(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** The phone placement. Hidden at >=1024px, where the sidebar carries it. */
export function TopBar() {
  return (
    <div className="topbar">
      <ViewToggle />
    </div>
  )
}
