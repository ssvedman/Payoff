import { NavLink } from 'react-router-dom'
import { NAV_ITEMS } from '../lib/navItems'

/**
 * Glyphs match mockups.html.
 *
 * History was added after the mockups and had no entry here, so the only way in
 * was one underlined text link on Home — the app's only view of how the balances
 * have actually moved, reachable by accident.
 *
 * The list now lives in lib/navItems.ts so this bar and the desktop sidebar
 * cannot drift apart. History is `inBottom: false` — seven is what fits across a
 * phone — and it keeps its place in the sidebar, which has the room.
 */
export default function BottomNav() {
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
      </div>
    </nav>
  )
}
