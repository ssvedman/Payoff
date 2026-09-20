import { money } from '../lib/format'

/**
 * Money in and money out, one pair of bars per month.
 *
 * Paired rather than stacked, and paired rather than netted. The whole claim
 * this page makes is that what arrives and what leaves track each other almost
 * exactly, and only two bars side by side let a reader check that claim: a net
 * bar shows the residue with the throughput hidden behind it, and a stack shows
 * a total neither figure is.
 *
 * Green is money in and steel is money out, which is the one colour pairing on
 * this page. Amber is absent by design: it means the current payoff target and
 * this page has no target. Red is absent too, because a month where more left
 * than arrived is not a deviation from a plan. The business has no plan to
 * deviate from, and the direction is already carried by which bar is taller.
 *
 * Desktop only. At 700 drawing units the month labels land near 4px on a phone,
 * so the narrow layout reports the same six months as a table of figures
 * instead.
 */

export interface BarMonth {
  key: string
  /** 'April'. */
  label: string
  /** 'April 2026', for the hover title. */
  longLabel: string
  moneyIn: number
  moneyOut: number
  /** The month still running, so its bars are not a month's worth yet. */
  current: boolean
  /** The record itself starts part-way through this month. */
  partial: boolean
}

const W = 700
const H = 152
/** The baseline, and the ceiling a full-height bar reaches. */
const BASE = 120
const TOP = 14
const SIDE = 22

export default function BusinessBars({ months }: { months: BarMonth[] }) {
  const max = Math.max(...months.map((m) => Math.max(m.moneyIn, m.moneyOut)), 0)

  if (months.length === 0 || max <= 0) {
    return <div className="sm muted">Nothing has been recorded on a business account yet.</div>
  }

  const innerW = W - SIDE * 2
  const slot = innerW / months.length
  const barW = Math.min(26, slot * 0.22)
  const gap = 4
  const span = BASE - TOP

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`Money in and money out, by month. ${months
          .map((m) => `${m.longLabel}: in ${money(m.moneyIn)}, out ${money(m.moneyOut)}`)
          .join('. ')}.`}
        style={{ display: 'block' }}
      >
        {months.map((m, i) => {
          const cx = SIDE + slot * i + slot / 2
          const inH = (m.moneyIn / max) * span
          const outH = (m.moneyOut / max) * span
          // A month that moved almost nothing still needs to read as a mark
          // rather than vanish into the axis.
          const hIn = Math.max(inH, 1.5)
          const hOut = Math.max(outH, 1.5)
          // The running month is drawn at full strength so it is legible as the
          // one that is not finished. Its caption says so in words, because
          // weight alone would read as emphasis rather than as incompleteness.
          const inOpacity = m.current ? 1 : 0.8
          const outOpacity = m.current ? 0.75 : 0.55

          return (
            <g key={m.key}>
              <rect
                x={cx - barW - gap / 2}
                y={BASE - hIn}
                width={barW}
                height={hIn}
                fill="var(--green)"
                opacity={inOpacity}
              >
                <title>{`${m.longLabel} · money in: ${money(m.moneyIn)}`}</title>
              </rect>
              <rect
                x={cx + gap / 2}
                y={BASE - hOut}
                width={barW}
                height={hOut}
                fill="var(--steel)"
                opacity={outOpacity}
              >
                <title>{`${m.longLabel} · money out: ${money(m.moneyOut)}`}</title>
              </rect>

              {/* Inside an SVG a text node renders in the browser's default
                  serif with proportional digits unless fontFamily="inherit" is
                  set on the node itself. Inheriting from the page does not
                  happen. */}
              <text
                x={cx}
                y={BASE + 15}
                fontSize="10.5"
                fill="var(--steel)"
                textAnchor="middle"
                fontFamily="inherit"
              >
                {m.label.slice(0, 3)}
              </text>
              {(m.current || m.partial) && (
                <text
                  x={cx}
                  y={BASE + 27}
                  fontSize="9"
                  fill="var(--steel)"
                  textAnchor="middle"
                  fontFamily="inherit"
                >
                  {m.current ? 'so far' : 'part'}
                </text>
              )}
            </g>
          )
        })}

        {/* A hairline baseline and nothing else. Gridlines here would compete
            with twelve bars for the same 106 vertical units. */}
        <line x1={SIDE - 6} y1={BASE} x2={W - SIDE + 6} y2={BASE} stroke="var(--line)" />
      </svg>

      <div className="legend">
        <span>
          <i className="sw" style={{ background: 'var(--green)', opacity: 0.8 }} aria-hidden="true" />
          money in
        </span>
        <span>
          <i className="sw" style={{ background: 'var(--steel)', opacity: 0.55 }} aria-hidden="true" />
          money out
        </span>
      </div>
    </div>
  )
}
