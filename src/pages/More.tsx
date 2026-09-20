import { Link } from 'react-router-dom'
import { MORE_ITEMS } from '../lib/navItems'

/**
 * The phone's fifth tab: everything the five-item bar has no room for.
 *
 * Generated from lib/navItems.ts rather than listed by hand, so a page added to
 * the nav cannot end up reachable on desktop and nowhere on a phone — which is
 * exactly how History was once reachable only by one underlined link on Home.
 *
 * Desktop never renders this: the sidebar carries all six items plus Settings,
 * so there is nothing left over to put behind a More.
 */
export default function More() {
  return (
    <main className="page">
      <h1 className="ph">More</h1>

      <div className="more-list">
        {MORE_ITEMS.map((it) => (
          <Link key={it.to} to={it.to} className="row more-row">
            <i className="more-row__icon" aria-hidden="true">
              {it.icon}
            </i>
            <div style={{ flex: 1 }}>
              <div className="sm" style={{ fontWeight: 600 }}>
                {it.label}
              </div>
              {it.blurb && <div className="tiny muted">{it.blurb}</div>}
            </div>
            <span className="muted" aria-hidden="true">
              ›
            </span>
          </Link>
        ))}
      </div>
    </main>
  )
}
