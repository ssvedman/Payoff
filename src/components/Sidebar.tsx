import { NavLink } from 'react-router-dom'
import { NAV_ITEMS, SETTINGS_ITEM } from '../lib/navItems'

/**
 * The desktop navigation, replacing the bottom bar at >=1024px.
 *
 * Always in the DOM and hidden by CSS below that width, so there is no
 * matchMedia flicker on first paint.
 *
 * Six destinations with a rule above Business — a different set of books, not
 * another household page — and Settings pinned to the foot below a second rule.
 * The Personal/Business toggle that used to sit at the top is gone: Business is
 * somewhere you go, not a mode the whole app is in.
 */
export default function Sidebar() {
  return (
    <aside className="sidebar" aria-label="Main">
      <div className="sidebar__brand">Payoff</div>

      <nav className="sidebar__nav">
        {NAV_ITEMS.map((it) => (
          <div key={it.to}>
            {it.dividerBefore && <div className="sidebar__divider" role="presentation" />}
            <NavLink
              to={it.to}
              end={it.end}
              className={({ isActive }) => (isActive ? 'on' : undefined)}
            >
              <i aria-hidden="true">{it.icon}</i>
              {it.label}
            </NavLink>
          </div>
        ))}
      </nav>

      <div className="sidebar__foot">
        <NavLink
          to={SETTINGS_ITEM.to}
          className={({ isActive }) => (isActive ? 'on' : undefined)}
        >
          <i aria-hidden="true">{SETTINGS_ITEM.icon}</i>
          {SETTINGS_ITEM.label}
        </NavLink>
      </div>
    </aside>
  )
}
