import { NavLink, useLocation } from 'react-router-dom'
import { MORE_ITEMS, NAV_ITEMS } from '../lib/navItems'

/**
 * The phone's bottom bar: Home, Spending, Progress, Calendar, More.
 *
 * Five is the limit before the labels stop being readable, so the four items
 * that do not fit live behind More — which is a route, not an overlay, so the
 * back button works and the page can be linked to.
 *
 * The list lives in lib/navItems.ts, and More is generated from the same list.
 * An item added there appears either in this bar or behind More, never nowhere:
 * a page reachable only by typing its URL is a page nobody has.
 */
export default function BottomNav() {
  const { pathname } = useLocation()

  // More stays lit while any page behind it is open, so the bar never shows
  // nothing selected. NavLink alone would only match /more itself, leaving
  // Accounts and Business looking like they belong to no tab at all.
  const moreIsOpen =
    pathname === '/more' || MORE_ITEMS.some((it) => pathname.startsWith(it.to))

  return (
    <nav className="nav" aria-label="Main">
      <div className="nav__inner">
        {NAV_ITEMS.filter((it) => it.inBottom).map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.end}
            className={({ isActive }) => (isActive ? 'on' : undefined)}
          >
            <i aria-hidden="true">{it.icon}</i>
            {it.label}
          </NavLink>
        ))}

        <NavLink
          to="/more"
          className={moreIsOpen ? 'on' : undefined}
          aria-current={moreIsOpen ? 'page' : undefined}
        >
          <i aria-hidden="true">≡</i>
          More
        </NavLink>
      </div>
    </nav>
  )
}
