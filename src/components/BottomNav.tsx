import { NavLink } from 'react-router-dom'

/**
 * Glyphs match mockups.html.
 *
 * History was added after the mockups and had no entry here, so the only way in
 * was one underlined text link on Home — the app's only view of how the balances
 * have actually moved, reachable by accident.
 */
const ITEMS = [
  { to: '/',          icon: '◈', label: 'Home' },
  { to: '/month',     icon: '▤', label: 'Month' },
  { to: '/activity',  icon: '≡', label: 'Activity' },
  { to: '/history',   icon: '◪', label: 'History' },
  { to: '/accounts',  icon: '◫', label: 'Accounts' },
  { to: '/settings',  icon: '⚙', label: 'Settings' },
]

export default function BottomNav() {
  return (
    <nav className="nav" aria-label="Main">
      <div className="nav__inner">
        {ITEMS.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.to === '/'}
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
