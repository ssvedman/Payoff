/**
 * The one nav list. The bottom bar, the desktop sidebar and the More sheet all
 * read it, so a page can never exist in one and be missing from another.
 *
 * Six destinations, then Settings pinned to the sidebar's foot.
 *
 * Business is a destination now, not a mode. It used to be reached by a
 * Personal/Business toggle that swapped the whole app, which meant the business
 * page had no place in navigation and the toggle had to be found before it
 * could be used. A divider separates it from the household pages: it is a
 * different set of books, and the rule that business money stays out of
 * household bucket maths is easier to keep when the two are not the same view
 * wearing different data.
 *
 * Month and History merged into Spending — one page with a month selector,
 * rather than "this month" and "the other months" as separate ideas.
 *
 * `inBottom` is the phone's five-item limit: Home, Spending, Progress, Calendar
 * and More. Eight glyphs across a phone gives labels nobody can read. Whatever
 * is not in the bottom bar is in the More sheet, which is generated from this
 * same list — so an item added here appears somewhere on a phone automatically
 * rather than becoming unreachable.
 */
export interface NavItem {
  to: string
  icon: string
  label: string
  /** Shown in the phone's bottom bar. All six show in the desktop sidebar. */
  inBottom: boolean
  /** NavLink `end` — only "/" needs it, or every route matches it. */
  end?: boolean
  /** A rule above this item in the sidebar. Business is a different set of books. */
  dividerBefore?: boolean
  /** One line under the label in the More sheet, where there is room for it. */
  blurb?: string
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', icon: '◈', label: 'Home', inBottom: true, end: true },
  {
    to: '/spending',
    icon: '▤',
    label: 'Spending',
    inBottom: true,
    blurb: 'Buckets and pace, any month',
  },
  { to: '/progress', icon: '◹', label: 'Progress', inBottom: true },
  { to: '/calendar', icon: '▦', label: 'Calendar', inBottom: true },
  {
    to: '/accounts',
    icon: '◫',
    label: 'Accounts',
    inBottom: false,
    blurb: 'Balances, assets, typed-in figures',
  },
  {
    to: '/activity',
    icon: '≡',
    label: 'Activity',
    inBottom: false,
    blurb: 'Every transaction',
  },
  {
    to: '/business',
    icon: '▣',
    label: 'Business',
    inBottom: false,
    dividerBefore: true,
    // Not the trading name. business.ts keeps it out of source deliberately —
    // this repository is public — and derives it from payment_aliases at run
    // time. A nav blurb is no different from any other string in the file.
    blurb: 'The other set of books',
  },
]

/**
 * Settings. Pinned to the foot of the sidebar below a rule, and listed last in
 * the More sheet.
 *
 * Kept out of NAV_ITEMS because its placement is not "next in the list" — it
 * sits at the bottom of the sidebar whatever else is added above it.
 */
export const SETTINGS_ITEM: NavItem = {
  to: '/settings',
  icon: '⚙',
  label: 'Settings',
  inBottom: false,
  blurb: 'Notifications, the plan, household',
}

/** Everything behind More on a phone: the four items the bottom bar has no room for. */
export const MORE_ITEMS: NavItem[] = [
  ...NAV_ITEMS.filter((it) => !it.inBottom),
  SETTINGS_ITEM,
]
