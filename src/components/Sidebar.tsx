import { NavLink } from 'react-router-dom'
import { NAV_ITEMS } from '../lib/navItems'
import ViewToggle from './ViewToggle'

/**
 * The desktop navigation, replacing the bottom bar at >=1024px.
 *
 * Always in the DOM and hidden by CSS below that width, so there is no
 * matchMedia flicker on first paint. It carries all eight items — including
 * History, which the phone bar has no room for.
 */
export default function Sidebar() {
  return (
    <aside className="sidebar" aria-label="Main">
      <div className="sidebar__brand">Payoff</div>

      <div className="sidebar__toggle">
        <ViewToggle />
      </div>

      <nav className="sidebar__nav">
        {NAV_ITEMS.map((it) => (
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
      </nav>
    </aside>
  )
}
