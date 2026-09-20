import { useEffect, useMemo, useState } from 'react'

/**
 * Three debt curves on one pair of axes: what has been measured, what the plan
 * projects, and what doing nothing would project.
 *
 * All three are the same quantity in the same units — total dollars owed — which
 * is the only reason they may share a y-axis at all. TrendChart deliberately
 * refuses to put two series on one chart for exactly the opposite reason.
 *
 * THE X AXIS IS ABSOLUTE MONTHS, over one domain shared by every series.
 * TrendChart maps x as i / (points.length - 1), which stretches whatever it is
 * given to the full width. Under that rule the 30-point plan and the 104-point
 * no-roll run would both reach the right-hand edge, and the chart would say the
 * plan takes exactly as long as doing nothing — the precise opposite of what the
 * data says, drawn confidently. Month 29 must land at 29/103 of the width.
 *
 * COLOUR CARRIES IDENTITY HERE, NOT JUDGEMENT. Ink is the plan, steel is doing
 * nothing, blue is what was measured. Amber is absent because it means the
 * current payoff target and nothing else. Green and red are absent because
 * painting the plan green and the alternative red would be the chart telling
 * someone what to do; the two lines and their labels already report the
 * difference, which is the whole job.
 *
 * Nothing animates, so there is nothing for a reduced-motion preference to turn
 * off — the same position TrendChart is in.
 */

export interface Milestone {
  /** Month number within the plan, 1-based, as SimResult.events reports it. */
  month: number
  /** Every account clearing in that month. More than one is normal. */
  names: string[]
}

export interface ActualReading {
  /** Months from the current calendar month. 0 is now; earlier months negative. */
  monthIndex: number
  total: number
}

interface Props {
  /** sim.balances — index n is the debt after n months. */
  plan: number[]
  /** noRollSim.balances, on the same basis and the same starting total. */
  noRoll: number[]
  /** Measured totals. Usually very few; sometimes exactly one. */
  actual: ActualReading[]
  /** Clearing events, already clustered by month. */
  milestones: Milestone[]
  format: (n: number) => string
  height?: number
  /**
   * What the chart is OF, for the screen-reader label. Three charts share this
   * component now, and one of them announcing itself as the others' subject is
   * worse than no label.
   */
  title?: string
  /** How the series read in the label, when they are not a debt being cleared. */
  planLabel?: string
  noRollLabel?: string
}

export const PLAN_COLOR = 'var(--ink)'
export const NOROLL_COLOR = 'var(--steel)'
/** Not a token: the palette has no fourth neutral, and the three reserved colours
 *  all mean something. A plain blue says "measured" without claiming good or bad. */
export const ACTUAL_COLOR = '#2a78d6'

const PAD = { top: 20, right: 16, bottom: 26, left: 16 }

/** Starting width, replaced by the measured one on the first layout pass. */
const W0 = 320

export default function ProjectionChart({
  plan,
  noRoll,
  actual,
  milestones,
  format,
  height = 210,
  title = 'Total debt',
  planLabel,
  noRollLabel,
}: Props) {
  /**
   * Held as an element in state rather than a useRef, because the first render
   * can return the empty-state branch with no wrapper to measure — a ref would
   * be read as null once and never looked at again.
   */
  const [wrap, setWrap] = useState<HTMLDivElement | null>(null)
  const [hover, setHover] = useState<number | null>(null)

  /**
   * The drawing width is MEASURED, never assumed — the same fix TrendChart
   * carries, for the same reason.
   *
   * viewBox="0 0 320 H" with width="100%" and the default preserveAspectRatio
   * scales by min(available / 320, availableHeight / H), and the height
   * attribute pins the second term at 1. So in any column wider than 320px the
   * chart drew at its native 320 units, centred in dead space — and onMove,
   * which maps clientX across the rendered rect, then reported the wrong month
   * under the cursor. On /progress at desktop the wrapper is 360px wide, enough
   * for the tooltip to name month 7 while the pointer sat on month 1.
   *
   * preserveAspectRatio="none" would fill the box by horizontally smearing every
   * stroke and label. Matching the viewBox to the real width keeps it 1:1.
   */
  const [W, setW] = useState(W0)

  useEffect(() => {
    if (!wrap) return
    const apply = (w: number) => {
      if (w > 0) setW(Math.round(w))
    }
    apply(wrap.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) apply(e.contentRect.width)
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [wrap])

  const H = height
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom

  const geom = useMemo(() => {
    if (plan.length === 0 || noRoll.length === 0) return null

    /**
     * Month 0 is this calendar month, where both simulations start. A measured
     * reading from an earlier month is therefore negative and the domain opens to
     * the left to hold it. Today every reading is from this month and the domain
     * is exactly 0…103, but hard-coding that lower bound would clip the actual
     * line the moment there is any history worth drawing.
     */
    const domainMin = Math.min(0, ...actual.map((a) => a.monthIndex))
    const domainMax = Math.max(plan.length - 1, noRoll.length - 1)
    const span = Math.max(1, domainMax - domainMin)

    /**
     * Money from zero. A fitted baseline would exaggerate the gap between two
     * curves that both end at nothing.
     *
     * Zero stays on the axis even when the values are NEGATIVE, which net worth
     * is for the next two years. Fitting the floor to the lowest value instead
     * would put the worst month on the bottom edge and make a balance sheet
     * climbing out of a hole look like one sitting on the floor — and it would
     * hide the crossing into positive, which is the single most meaningful point
     * on that chart.
     */
    const values = [...plan, ...noRoll, ...actual.map((a) => a.total)]
    const maxV = Math.max(...values, 1)
    const minV = Math.min(...values, 0)
    const spanV = Math.max(maxV - minV, 1)

    const x = (m: number) => PAD.left + ((m - domainMin) / span) * innerW
    const y = (v: number) => PAD.top + innerH - ((v - minV) / spanV) * innerH

    const path = (values: number[], from = 0) =>
      values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(from + i)},${y(v)}`).join(' ')

    return {
      domainMin,
      domainMax,
      x,
      y,
      maxV,
      minV,
      planPath: path(plan),
      noRollPath: path(noRoll),
      actualPath: actual.map((a, i) => `${i === 0 ? 'M' : 'L'}${x(a.monthIndex)},${y(a.total)}`).join(' '),
    }
  }, [plan, noRoll, actual, innerW, innerH])

  if (!geom) {
    return (
      <div className="sm muted" style={{ padding: '18px 0' }}>
        No projection yet.
      </div>
    )
  }

  const { x, y, domainMin, domainMax, minV } = geom
  const baselineY = PAD.top + innerH
  /** Where zero sits. Below the floor when everything is positive. */
  const zeroY = y(0)
  const showsZeroLine = minV < 0
  const planMonths = plan.length - 1
  const noRollMonths = noRoll.length - 1

  /** Balance after `m` months. Past the end of a run the debt is gone, not missing. */
  const at = (values: number[], m: number) => (m < values.length ? values[m] : 0)

  function onMove(e: React.PointerEvent) {
    if (!wrap) return
    const rect = wrap.getBoundingClientRect()
    const vx = ((e.clientX - rect.left) / rect.width) * W
    const m = Math.round(domainMin + ((vx - PAD.left) / innerW) * (domainMax - domainMin))
    setHover(Math.max(0, Math.min(domainMax, m)))
  }

  return (
    <div>
      <div ref={setWrap} style={{ position: 'relative' }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={H}
          role="img"
          aria-label={
            `${title} by month. ` +
            (planLabel && noRollLabel
              ? `${planLabel}; ${noRollLabel}. `
              : `The plan clears it in ${planMonths} months; ` +
                `paying minimums only takes ${noRollMonths}. `) +
            (actual.length > 0
              ? `${actual.length} month${actual.length === 1 ? '' : 's'} measured so far.`
              : 'Nothing measured yet.')
          }
          style={{ display: 'block', touchAction: 'pan-y' }}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {/* Zero, when the values cross it. On a net worth chart this is the
              line the balance sheet is climbing towards, so it is drawn a shade
              stronger than the floor and labelled. */}
          {showsZeroLine && (
            <>
              <line
                x1={PAD.left}
                y1={zeroY}
                x2={W - PAD.right}
                y2={zeroY}
                stroke="var(--steel)"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              <text
                x={PAD.left}
                y={zeroY - 4}
                className="tnum"
                fontFamily="inherit"
                fontSize="9"
                fill="var(--steel)"
              >
                0
              </text>
            </>
          )}

          {/* Hairline baseline only — no gridlines competing with three series. */}
          <line
            x1={PAD.left}
            y1={baselineY}
            x2={W - PAD.right}
            y2={baselineY}
            stroke="var(--line)"
            strokeWidth="1"
          />

          {/* Crosshair first, so it sits under every line. */}
          {hover !== null && (
            <line
              x1={x(hover)}
              y1={PAD.top}
              x2={x(hover)}
              y2={baselineY}
              stroke="var(--steel)"
              strokeWidth="1"
              opacity="0.45"
            />
          )}

          {/* Doing nothing underneath: it is the backdrop the plan is read against. */}
          <path
            d={geom.noRollPath}
            fill="none"
            stroke={NOROLL_COLOR}
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          <path
            d={geom.planPath}
            fill="none"
            stroke={PLAN_COLOR}
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/*
            Clearing events, one marker per MONTH rather than per account. Three
            accounts clear in month 2 and two in each of months 9 and 25; at about
            2.8 viewBox units per month, three markers with three labels inside
            eight units is a smudge with unreadable text over it. The names live in
            the list below the chart, where the month-2 row simply carries three of
            them, and the numeral here is what joins the two.
          */}
          {milestones.map((ms, i) => {
            const mx = x(ms.month)
            const my = y(at(plan, ms.month))
            // Alternate rows, so two markers a single month apart never put their
            // numerals side by side. Both rows sit ABOVE the plan line, in the gap
            // between it and the no-roll line, which is empty everywhere it matters.
            const ly = my - (i % 2 === 0 ? 8 : 17)
            return (
              <g key={`${ms.month}-${i}`}>
                <circle cx={mx} cy={my} r="3" fill={PLAN_COLOR} stroke="var(--bg)" strokeWidth="1.2" />
                <text
                  x={mx}
                  y={ly}
                  className="tnum"
                  fontSize="8.5"
                  fontWeight="700"
                  fill="var(--ink)"
                  textAnchor="middle"
                  fontFamily="inherit"
                  // A halo in the page background colour, so a numeral that lands
                  // on the no-roll line is still legible.
                  stroke="var(--bg)"
                  strokeWidth="2.5"
                  paintOrder="stroke"
                >
                  {i + 1}
                </text>
              </g>
            )
          })}

          {/*
            What was actually measured. With one reading it is a dot, not a line,
            and it is drawn as a dot — a two-point line through invented history
            would be a lie told in a very small space.
          */}
          {actual.length > 1 && (
            <path
              d={geom.actualPath}
              fill="none"
              stroke={ACTUAL_COLOR}
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          {actual.map((a) => (
            <circle
              key={a.monthIndex}
              cx={x(a.monthIndex)}
              cy={y(a.total)}
              r="3.6"
              fill={ACTUAL_COLOR}
              stroke="var(--bg)"
              strokeWidth="1.4"
            />
          ))}
          {actual.length > 0 && (
            /*
              Below the marker, not above it. Above is where the starting total
              and the first milestone numerals live, and at this scale the whole
              of the measured data sits in the top-left corner with them. The
              halo is what keeps it readable where the plan line runs through.
            */
            <text
              x={x(actual[0].monthIndex) + 2}
              y={y(actual[0].total) + 20}
              fontSize="9"
              fill={ACTUAL_COLOR}
              fontWeight="700"
              fontFamily="inherit"
              stroke="var(--bg)"
              strokeWidth="2.5"
              paintOrder="stroke"
            >
              measured
            </text>
          )}

          {/* X axis: now, the month the plan finishes, and the month doing nothing
              would. Three labels, no ticks between them — the months in the list
              below carry the detail. */}
          <text
            x={PAD.left}
            y={H - 6}
            fontSize="10"
            fill="var(--steel)"
            fontFamily="inherit"
          >
            now
          </text>
          <line
            x1={x(planMonths)}
            y1={baselineY}
            x2={x(planMonths)}
            y2={baselineY + 3}
            stroke="var(--line)"
            strokeWidth="1"
          />
          <text
            x={x(planMonths)}
            y={H - 6}
            className="tnum"
            fontSize="10"
            fill="var(--ink)"
            textAnchor="middle"
            fontFamily="inherit"
          >
            {planMonths} mo
          </text>
          <text
            x={W - PAD.right}
            y={H - 6}
            className="tnum"
            fontSize="10"
            fill="var(--steel)"
            textAnchor="end"
            fontFamily="inherit"
          >
            {noRollMonths} mo
          </text>

          {/*
            The top of the y axis, once. Today that is the starting total, because
            both curves leave from it and only ever fall. It is written as maxV
            rather than plan[0] so that a measured reading from a month when the
            debt was HIGHER still labels the axis it actually sets — the scale and
            its label must never be able to disagree.
          */}
          <text
            x={PAD.left}
            y={PAD.top - 8}
            className="tnum"
            fontSize="10"
            fill="var(--steel)"
            fontFamily="inherit"
          >
            {format(geom.maxV)}
          </text>
        </svg>

        {hover !== null && (
          <div
            role="status"
            className="tiny"
            style={{
              position: 'absolute',
              top: 0,
              left: `${Math.min(Math.max((x(hover) / W) * 100, 16), 84)}%`,
              transform: 'translateX(-50%)',
              background: 'var(--ink)',
              color: '#fff',
              padding: '5px 9px',
              borderRadius: 'var(--r-control)',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              lineHeight: 1.4,
            }}
          >
            <div className="tnum" style={{ opacity: 0.7 }}>
              month {hover}
            </div>
            <div className="tnum">plan {format(at(plan, hover))}</div>
            <div className="tnum" style={{ opacity: 0.8 }}>
              nothing {format(at(noRoll, hover))}
            </div>
          </div>
        )}
      </div>

      {/* Legend. Three series need naming somewhere, and naming them in the SVG
          means three more text nodes fighting the lines for space. */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6px 16px',
          marginTop: 8,
        }}
      >
        <LegendItem color={PLAN_COLOR} label="The plan" />
        <LegendItem color={NOROLL_COLOR} label="Doing nothing" />
        <LegendItem
          color={ACTUAL_COLOR}
          label={actual.length > 0 ? 'Actual, measured' : 'Actual — no readings yet'}
          dotted={actual.length === 0}
        />
      </div>
    </div>
  )
}

function LegendItem({
  color,
  label,
  dotted = false,
}: {
  color: string
  label: string
  dotted?: boolean
}) {
  return (
    <span className="tiny" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        aria-hidden="true"
        style={{
          width: 14,
          height: 0,
          borderTop: `2px ${dotted ? 'dotted' : 'solid'} ${color}`,
          display: 'inline-block',
        }}
      />
      {label}
    </span>
  )
}
