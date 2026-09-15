import { NavLink } from 'react-router-dom'

/** Glyphs match mockups.html exactly. */
const ITEMS = [
  { to: '/',          icon: '◈', label: 'Home' },
  { to: '/month',     icon: '▤', label: 'Month' },
  { to: '/activity',  icon: '≡', label: 'Activity' },
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
