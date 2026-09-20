/**
 * The one nav list. The bottom bar and the desktop sidebar both read it, so a
 * page can never exist in one and be missing from the other.
 *
 * History is the reason this file exists: it was added after the mockups, had no
 * entry in the bottom bar, and the only way in was a single underlined text link
 * on Home — the app's only view of how balances have actually moved, reachable
 * by accident. `inBottom` is false for it only because seven glyphs is what fits
 * across a phone; the sidebar has room and carries all eight.
 *
 * Business is deliberately absent. It is reached by the Personal/Business
 * toggle, not by navigation — it is a different view of the app, not a page
 * inside the household one.
 */
export interface NavItem {
  to: string
  icon: string
  label: string
  /** Shown in the phone's bottom bar. All items show in the desktop sidebar. */
  inBottom: boolean
  /** NavLink `end` — only "/" needs it, or every route matches it. */
  end?: boolean
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/',          icon: '◈', label: 'Home',     inBottom: true, end: true },
  { to: '/month',     icon: '▤', label: 'Month',    inBottom: true },
  { to: '/progress',  icon: '◹', label: 'Progress', inBottom: true },
  { to: '/calendar',  icon: '▦', label: 'Calendar', inBottom: true },
  { to: '/activity',  icon: '≡', label: 'Activity', inBottom: true },
  { to: '/history',   icon: '◪', label: 'History',  inBottom: false },
  { to: '/accounts',  icon: '◫', label: 'Accounts', inBottom: true },
  { to: '/settings',  icon: '⚙', label: 'Settings', inBottom: true },
]
