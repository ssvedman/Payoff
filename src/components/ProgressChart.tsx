import { useEffect, useMemo, useState } from 'react'
import type { Milestone, PlanProjection } from '../lib/planVersion'
import { MONTH_NAMES, parseDateOnly } from '../lib/format'

/**
 * Total owed by month: the frozen plan, the frozen minimums-only counterfactual,
 * what has actually been measured, and a dot wherever an account clears.
 *
 * EVERY PROJECTED POINT HERE IS READ FROM plan_projections. Nothing on this
 * chart is simulated. The component takes rows, not debts, precisely so it
 * cannot acquire the ability to compute a line of its own — the old
 * ProjectionChart took `number[]` produced by simulate() on every render, and
 * the plan line therefore moved whenever a balance moved.
 *
 * THE X AXIS IS ABSOLUTE MONTHS FROM THE PLAN'S effective_from, over one domain
 * shared by every series. Mapping x as i / (points.length - 1) would stretch the
 * 30-point plan and the 104-point minimums run to the same right-hand edge, so
 * the chart would say the plan takes exactly as long as doing nothing: the
 * precise opposite of what the data says, drawn confidently. Month 29 lands at
 * 29/103 of the width.
 *
 * COLOUR. There is no amber on this page at all.
 *
 * Amber means the current payoff target and nothing else, and no target account
 * is named on Progress. The mockup drew the actual line amber, which contradicts
 * the rule it also states: reserving a colour only works if it is reserved, and
 * every extra use costs a little of the ability to find the target without
 * reading anything.
 *
 * So the three lines are told apart by WEIGHT and DASH rather than by hue:
 * the actual line is solid ink at the heaviest stroke, because it is the one
 * thing on the chart that is measured rather than projected; the plan is the
 * same ink dashed, because it is a projection; and minimums-only stays steel,
 * the colour this app already uses for the do-nothing line. Green still marks
 * an account clearing.
 *
 * Nothing animates, so there is nothing for a reduced-motion preference to
 * turn off.
 */

export const PLAN_COLOR = 'var(--ink)'
export const MINIMUMS_COLOR = 'var(--steel)'
/** Solid ink, heaviest stroke. Measured, not projected, so it carries no dash. */
export const ACTUAL_COLOR = 'var(--ink)'
export const CLEARED_COLOR = 'var(--green)'
/** The plan is a projection, so it is the same ink as the actual line, dashed. */
export const PLAN_DASH = '7 5'

export interface ActualReading {
  /** Months from the plan's effective_from, on the same basis as month_index. */
  monthIndex: number
  total: number
}

interface Props {
  /** plan_projections rows for scenario 'plan', month 0 first. */
  plan: PlanProjection[]
  /**
   * The FIRST version's plan rows, when the plan has since been revised.
   *
   * Drawn faint behind the current plan so a revision reads as a decision that
   * was taken on a date, rather than as the target having always been where it
   * is now. Absent until a second version exists.
   */
  originalPlan?: PlanProjection[] | null
  /** The same for 'minimums_only'. */
  minimums: PlanProjection[]
  /** Measured totals. Usually very few; sometimes exactly one. */
  actual: ActualReading[]
  /** Months where at least one account clears under the plan. */
  milestones: Milestone[]
  format: (n: number) => string
  height?: number
}

/** Starting width, replaced by the measured one on the first layout pass. */
const W0 = 320

/** "Feb 2029" from a date-only column, built from parts so no locale can move it. */
function monthYear(iso: string): string {
  const d = parseDateOnly(iso)
  return `${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`
}

/**
 * Gridline values from 0 up to just under `max`, at a step a person reads
 * without doing arithmetic: a small round multiple of a power of ten.
 *
 * The step NEAREST to max/target is chosen rather than the first one at or
 * above it. Rounding up is what turns a six-figure debt over four divisions
 * into gridlines every $50k — three lines where four were asked for, and a
 * chart that has quietly become coarser than the one it was drawn to be.
 *
 * The top gridline sits BELOW the maximum rather than on it. The y axis is
 * scaled to the real maximum, so a line drawn at a rounded-up value would be a
 * gridline labelled with a number the data never reaches.
 */
function gridValues(max: number, target: number): number[] {
  const raw = max / target
  const mag = 10 ** Math.floor(Math.log10(raw))
  const steps = [1, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * mag)
  const step = steps.reduce((best, s) =>
    Math.abs(s - raw) < Math.abs(best - raw) ? s : best,
  )
  const out: number[] = []
  for (let v = 0; v <= max; v += step) out.push(v)
  return out
}

/** "$120k" / "$500". Axis labels, where the cents are noise. */
function axisMoney(v: number): string {
  if (v === 0) return '0'
  if (Math.abs(v) >= 1000) return `$${Math.round(v / 1000)}k`
  return `$${Math.round(v)}`
}

export default function ProgressChart({
  plan,
  originalPlan,
  minimums,
  actual,
  milestones,
  format,
  height,
}: Props) {
  /**
   * Held as an element in state rather than a useRef, because the first render
   * can return the empty-state branch with no wrapper to measure — a ref would
   * be read as null once and never looked at again.
   */
  const [wrap, setWrap] = useState<HTMLDivElement | null>(null)
  const [hover, setHover] = useState<number | null>(null)

  /**
   * The drawing width is MEASURED, never assumed.
   *
   * viewBox="0 0 320 H" with width="100%" and the default preserveAspectRatio
   * scales by min(available / 320, availableHeight / H), and the height
   * attribute pins the second term at 1. So in any column wider than 320px the
   * chart draws at its native 320 units, centred in dead space — and onMove,
   * which maps clientX across the rendered rect, then reports the wrong month
   * under the cursor. preserveAspectRatio="none" would fill the box by
   * horizontally smearing every stroke and label. Matching the viewBox to the
   * real width keeps it 1:1.
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

  /** A phone's width. The axis gutter and the label density both come off this. */
  const narrow = W < 420
  /**
   * The height follows the measured width rather than being fixed, because a
   * 250px-tall chart in a 340px-wide column is nearly square and reads as a
   * cliff: the same two curves, steeper, saying something the numbers do not.
   * The mockup draws the desktop chart at roughly 880 by 240 and the phone at
   * 300 by 140, and these are those two shapes.
   */
  const H = height ?? (narrow ? 160 : 250)
  const PAD = {
    top: 16,
    right: 14,
    // Room for "$120k" flush right of the gridlines, and less of it on a phone
    // where the labels drop the dollar sign's worth of characters anyway.
    left: narrow ? 34 : 50,
    bottom: 30,
  }
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom

  const geom = useMemo(() => {
    if (plan.length === 0 || minimums.length === 0) return null

    /**
     * Month 0 is the plan's effective_from. A measured reading taken before the
     * plan began is therefore negative and the domain opens to the left to hold
     * it. Hard-coding a floor of 0 would clip exactly the readings that show
     * where the household was when the plan was written.
     */
    const domainMin = Math.min(0, ...actual.map((a) => a.monthIndex))
    const domainMax = Math.max(
      plan[plan.length - 1].month_index,
      minimums[minimums.length - 1].month_index,
    )
    const span = Math.max(1, domainMax - domainMin)

    /**
     * Money from zero. A fitted baseline would exaggerate the gap between two
     * curves that both end at nothing.
     */
    const maxV = Math.max(
      ...plan.map((p) => p.projected_debt),
      ...minimums.map((p) => p.projected_debt),
      ...actual.map((a) => a.total),
      1,
    )

    const x = (m: number) => PAD.left + ((m - domainMin) / span) * innerW
    const y = (v: number) => PAD.top + innerH - (v / maxV) * innerH

    const path = (rows: PlanProjection[]) =>
      rows
        .map((r, i) => `${i === 0 ? 'M' : 'L'}${x(r.month_index)},${y(r.projected_debt)}`)
        .join(' ')

    return {
      domainMin,
      domainMax,
      x,
      y,
      maxV,
      planPath: path(plan),
      originalPath: originalPlan && originalPlan.length > 0 ? path(originalPlan) : null,
      minimumsPath: path(minimums),
      actualPath: actual
        .map((a, i) => `${i === 0 ? 'M' : 'L'}${x(a.monthIndex)},${y(a.total)}`)
        .join(' '),
      /** Debt by month index, for the milestone dots and the tooltip. */
      planAt: new Map(plan.map((r) => [r.month_index, r.projected_debt])),
      minimumsAt: new Map(minimums.map((r) => [r.month_index, r.projected_debt])),
    }
  }, [plan, originalPlan, minimums, actual, innerW, innerH, PAD.left, PAD.top])

  if (!geom) {
    return (
      <div className="sm muted" style={{ padding: '18px 0' }}>
        No projection rows to draw.
      </div>
    )
  }

  const { x, y, domainMin, domainMax, maxV } = geom
  const baselineY = PAD.top + innerH
  const planMonths = plan[plan.length - 1].month_index
  const minimumsMonths = minimums[minimums.length - 1].month_index
  const debtFreeOn = plan[plan.length - 1].projected_on
  /**
   * Whether the stored plan actually reaches nothing. A run that ends with debt
   * still on it hit the generator's ceiling instead of finishing, and the green
   * "debt free" tick would then be putting a date on something that never
   * happens in the row it is drawn from.
   */
  const planClears = plan[plan.length - 1].projected_debt <= 0.005
  const endColor = planClears ? CLEARED_COLOR : 'var(--steel)'
  const grid = gridValues(maxV, narrow ? 2 : 4)

  /** Debt after `m` months. Past the end of a run the debt is gone, not missing. */
  const at = (rows: Map<number, number>, m: number) => rows.get(m) ?? (m > 0 ? 0 : maxV)

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
            (planClears
              ? `Total owed by month. The plan clears it in ${planMonths} months; `
              : `Total owed by month. The plan runs ${planMonths} months without clearing it; `) +
            `paying minimums only takes ${minimumsMonths}. ` +
            (actual.length > 0
              ? `${actual.length} month${actual.length === 1 ? '' : 's'} measured so far.`
              : 'Nothing measured yet.')
          }
          style={{ display: 'block', touchAction: 'pan-y' }}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {/* Gridlines and the y axis, drawn first so every series sits over
              them. Zero is a shade stronger: it is where both curves are
              heading, not just another division of the axis. */}
          {grid.map((v) => (
            <g key={v}>
              <line
                x1={PAD.left}
                y1={y(v)}
                x2={W - PAD.right}
                y2={y(v)}
                stroke={v === 0 ? 'var(--line)' : 'var(--bg)'}
                strokeWidth="1"
              />
              <text
                x={PAD.left - 6}
                y={y(v) + 3.5}
                className="tnum"
                fontSize={narrow ? '8.5' : '9.5'}
                fill="var(--steel)"
                textAnchor="end"
                fontFamily="inherit"
              >
                {axisMoney(v)}
              </text>
            </g>
          ))}

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

          {/* Minimums only underneath: it is the backdrop the plan is read
              against, not a line anyone is following. */}
          <path
            d={geom.minimumsPath}
            fill="none"
            stroke={MINIMUMS_COLOR}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* The original plan, faint and behind the current one. A revision
              is a decision taken on a date, and drawing only the plan now in
              force would let the target look as though it had always been
              here. Same dash as the current plan, because it is the same kind
              of thing; lighter, because it is not the one being followed. */}
          {geom.originalPath && (
            <path
              d={geom.originalPath}
              fill="none"
              stroke={PLAN_COLOR}
              strokeWidth="1.6"
              strokeDasharray={PLAN_DASH}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.38"
            />
          )}

          <path
            d={geom.planPath}
            fill="none"
            stroke={PLAN_COLOR}
            strokeWidth="2.2"
            strokeDasharray={PLAN_DASH}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/*
            One dot per MONTH in which something clears, not one per account.
            Three accounts clear in month 2 and two in each of months 9 and 25;
            at roughly nine viewBox units per month on a desktop column, three
            dots inside that span is a smudge. The clearing order beneath names
            every account in each month, which is where the detail belongs.
          */}
          {milestones.map((ms) => {
            const last = ms.month_index === planMonths
            return (
              <circle
                key={ms.month_index}
                cx={x(ms.month_index)}
                cy={y(at(geom.planAt, ms.month_index))}
                r={last ? 5 : 3.5}
                fill={CLEARED_COLOR}
                stroke="var(--white)"
                strokeWidth="1.2"
              />
            )
          })}

          {/*
            What was actually measured. With one reading it is a dot, not a
            line, and it is drawn as a dot — a two-point line through invented
            history would be a lie told in a very small space.
          */}
          {actual.length > 1 && (
            <path
              d={geom.actualPath}
              fill="none"
              stroke={ACTUAL_COLOR}
              strokeWidth="3.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          {actual.map((a) => (
            <circle
              key={a.monthIndex}
              cx={x(a.monthIndex)}
              cy={y(a.total)}
              r="4.5"
              fill={ACTUAL_COLOR}
              stroke="var(--white)"
              strokeWidth="1.4"
            />
          ))}

          {/* X axis. Where the plan ends is the only interior label, because it
              is the only x value on the chart anybody is waiting for. */}
          {!narrow && (
            <text
              x={PAD.left}
              y={H - 8}
              fontSize="10"
              fill="var(--steel)"
              fontFamily="inherit"
            >
              now
            </text>
          )}
          <line
            x1={x(planMonths)}
            y1={baselineY}
            x2={x(planMonths)}
            y2={baselineY + 4}
            stroke={endColor}
            strokeWidth="1"
          />
          <text
            x={x(planMonths)}
            y={H - 8}
            className="tnum"
            fontSize={narrow ? '9' : '10'}
            fill={endColor}
            fontWeight="700"
            textAnchor="middle"
            fontFamily="inherit"
          >
            {planClears
              ? narrow
                ? monthYear(debtFreeOn)
                : `debt free · ${monthYear(debtFreeOn)}`
              : `month ${planMonths}`}
          </text>
          <text
            x={W - PAD.right}
            y={H - 8}
            className="tnum"
            fontSize={narrow ? '9' : '10'}
            fill="var(--steel)"
            textAnchor="end"
            fontFamily="inherit"
          >
            {minimumsMonths} mo
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
            <div className="tnum">plan {format(at(geom.planAt, hover))}</div>
            <div className="tnum" style={{ opacity: 0.8 }}>
              minimums {format(at(geom.minimumsAt, hover))}
            </div>
          </div>
        )}
      </div>

      {/* One legend for all four marks. Naming them inside the SVG would mean
          four more text nodes fighting the lines for space. */}
      <div className="legend">
        <span>
          {/* Dashed, matching the line. The plan and the actual line are both
              ink now, so the dash is the only thing telling them apart and the
              legend has to carry it too or the two entries read as one. */}
          <i className="sw sw--dashed" style={{ color: PLAN_COLOR }} aria-hidden="true" />
          The plan
        </span>
        {geom.originalPath && (
          <span>
            <i
              className="sw sw--dashed"
              style={{ color: PLAN_COLOR, opacity: 0.38 }}
              aria-hidden="true"
            />
            The original plan
          </span>
        )}
        <span>
          <i className="sw" style={{ background: MINIMUMS_COLOR }} aria-hidden="true" />
          Minimums only
        </span>
        <span>
          <i className="sw" style={{ background: ACTUAL_COLOR }} aria-hidden="true" />
          {actual.length > 0 ? 'Actual' : 'Actual — no readings yet'}
        </span>
        <span>
          <i
            className="sw sw--dot"
            style={{ background: CLEARED_COLOR }}
            aria-hidden="true"
          />
          an account clears
        </span>
      </div>
    </div>
  )
}

/**
 * The shape of a projected series in a stat card, with no axes and no figures.
 *
 * It says "this direction, this steepness" and nothing more, which is all a
 * 40px-tall drawing can honestly say. The number beside it carries the value.
 */
export function ProgressSparkline({
  values,
  color = CLEARED_COLOR,
  height = 34,
}: {
  values: number[]
  color?: string
  height?: number
}) {
  if (values.length < 2) return null

  const W = 200
  const H = height
  const pad = 3
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = Math.max(max - min, 1)

  const d = values
    .map((v, i) => {
      const x = pad + (i / (values.length - 1)) * (W - pad * 2)
      const yy = pad + (1 - (v - min) / span) * (H - pad * 2)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${yy.toFixed(1)}`
    })
    .join(' ')

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      aria-hidden="true"
      style={{ display: 'block', marginTop: 7 }}
    >
      <path d={d} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" />
    </svg>
  )
}
