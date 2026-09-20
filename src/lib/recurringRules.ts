import { isoDate, parseDateOnly } from './format'
import { clampedDay, type Series, type Direction } from './cadence'

/**
 * The RULES half of recurring overrides — pure, no supabase, no React.
 *
 * Split out from recurring.ts so it can actually be imported and exercised on
 * its own. It used to sit beside the hook under a comment claiming the split was
 * "deliberate ... so it stays testable", which was not true of a module that
 * imported the supabase client three lines above: the first attempt to test it
 * failed to resolve. A claim about testability is worth exactly as much as the
 * test that runs.
 *
 * The dismiss boundary is the part worth being careful about. See applyOverrides.
 */

export type OverrideAction = 'dismiss' | 'confirm'
export type ConfirmCadence = 'weekly' | 'fortnightly' | 'monthly'

/** Days between events, per cadence. Used to project a confirmed series. */
const CADENCE_DAYS: Record<ConfirmCadence, number> = {
  weekly: 7,
  fortnightly: 14,
  monthly: 30,
}

export interface Override {
  id: string
  seriesKey: string
  accountId: string | null
  descriptor: string
  label: string
  direction: Direction
  action: OverrideAction
  dismissedAfter: string | null
  cadence: ConfirmCadence | null
  expectedAmount: number | null
  anchorOn: string | null
  createdAt: string
}

export function toOverride(r: Record<string, unknown>): Override {
  return {
    id: r.id as string,
    seriesKey: r.series_key as string,
    accountId: (r.account_id as string | null) ?? null,
    descriptor: (r.descriptor as string) ?? '',
    label: (r.label as string) ?? '',
    direction: (r.direction as Direction) ?? 'out',
    action: (r.action as OverrideAction) ?? 'dismiss',
    dismissedAfter: (r.dismissed_after as string | null) ?? null,
    cadence: (r.cadence as ConfirmCadence | null) ?? null,
    // numeric arrives from PostgREST as a string.
    expectedAmount: r.expected_amount === null || r.expected_amount === undefined
      ? null
      : Number(r.expected_amount),
    anchorOn: (r.anchor_on as string | null) ?? null,
    createdAt: r.created_at as string,
  }
}

/** A dismissed series that has charged again since it was dismissed. */
export interface Resurrected {
  series: Series
  override: Override
  /** Dates of events after the dismissal. At least one, or this is not a return. */
  chargedOn: string[]
  /** What those events came to. */
  total: number
}

export interface AppliedSeries {
  /** Series that should be projected onto the grid. */
  active: Series[]
  /** Dismissed, still quiet — no event since the dismissal. */
  dismissed: { series: Series | null; override: Override }[]
  /** Dismissed and charged anyway. The reason this feature exists. */
  resurrected: Resurrected[]
}

/**
 * Apply standing instructions to a freshly detected set of series.
 *
 * `detected` is everything detectSeries() produced, dated or not — a dismissed
 * series may well have fallen out of the projectable set, and it still has to be
 * checked for a return.
 */
export function applyOverrides(detected: Series[], overrides: Override[]): AppliedSeries {
  const byKey = new Map(overrides.map((o) => [o.seriesKey, o]))
  const seriesByKey = new Map(detected.map((s) => [s.key, s]))

  const active: Series[] = []
  const dismissed: { series: Series | null; override: Override }[] = []
  const resurrected: Resurrected[] = []

  for (const s of detected) {
    const o = byKey.get(s.key)
    if (!o || o.action !== 'dismiss') {
      active.push(s)
      continue
    }

    // Strictly after: an event ON the dismissal boundary is the charge that was
    // being dismissed, not a new one. Using >= would report every dismissal as
    // an immediate failure to cancel.
    const after = (o.dismissedAfter ?? '') as string
    const since = s.events.filter((e) => e.date > after)

    if (since.length === 0) {
      dismissed.push({ series: s, override: o })
      continue
    }

    resurrected.push({
      series: s,
      override: o,
      chargedOn: since.map((e) => e.date),
      total: Math.round(since.reduce((sum, e) => sum + e.amount, 0) * 100) / 100,
    })
    // A series that came back is ACTIVE again. It is being charged; leaving it
    // out of the running balance would understate what is going to leave the
    // account, which is the error that costs money rather than the one that
    // merely looks untidy.
    active.push(s)
  }

  // A dismissal whose series is no longer detected at all — it fell out of the
  // 180-day window. Still listed, so a member can see what they dismissed and
  // undo it, and so a dismissal is never silently forgotten.
  for (const o of overrides) {
    if (o.action !== 'dismiss') continue
    if (seriesByKey.has(o.seriesKey)) continue
    dismissed.push({ series: null, override: o })
  }

  return { active, dismissed, resurrected }
}

/**
 * Turn a 'confirm' override into a projectable series.
 *
 * Detection needs three observations; this needs none. That is the point — a
 * loan whose first payment falls next month has no history to infer from, and
 * leaving it off the grid understates every projected balance after its due
 * date.
 *
 * Only used for keys detection did NOT produce. Once enough history exists, the
 * detected series is the better description — it is measured rather than
 * asserted — so the real one wins and this is skipped.
 */
export function confirmedSeries(
  overrides: Override[],
  detected: Series[],
  today: Date,
): Series[] {
  const detectedKeys = new Set(detected.map((s) => s.key))
  const todayIso = isoDate(today)

  return overrides
    .filter((o) => o.action === 'confirm' && !detectedKeys.has(o.seriesKey))
    .map((o) => {
      const anchor = o.anchorOn ?? todayIso
      const cadence = o.cadence ?? 'monthly'

      /**
       * Advance from the anchor to the first date that has not already passed.
       *
       * MONTHLY steps a CALENDAR month, not 30 days. Stepping 30 walks a bill
       * anchored on the 15th backwards — to the 14th, the 13th, and about 24 days
       * off over a year — so a loan payment would be projected into the wrong
       * week within two months. The day is clamped to the month's length, so the
       * 31st lands on the 30th in April rather than rolling into May.
       *
       * Anchoring forward from the stated start rather than back from today keeps
       * a confirmed obligation's first payment on the day it was said to fall.
       */
      const start = parseDateOnly(anchor)
      const day = start.getDate()
      let d = new Date(start)
      const guard = 400
      let n = 0
      while (isoDate(d) < todayIso && n < guard) {
        d =
          cadence === 'monthly'
            ? clampedDay(d.getFullYear(), d.getMonth() + 1, day)
            : new Date(d.getFullYear(), d.getMonth(), d.getDate() + CADENCE_DAYS[cadence])
        n++
      }
      const nextOn = isoDate(d)
      const amount = o.expectedAmount ?? 0

      return {
        key: o.seriesKey,
        accountId: o.accountId ?? '',
        direction: o.direction,
        label: o.label,
        descriptor: o.descriptor,
        // No observations are claimed, because none were made. Everything below
        // is asserted by a member, and the page says so rather than presenting
        // it as measurement.
        events: [],
        firstOn: anchor,
        lastOn: anchor,
        daysSinceLast: 0,
        medianAmount: amount,
        medianGap: CADENCE_DAYS[cadence],
        madGap: 0,
        onBeat: 1,
        missedCycles: 0,
        kind: cadence,
        dayOfMonth: cadence === 'monthly' ? day : null,
        nextOn,
        overdue: false,
        stopped: false,
        note: 'marked as recurring by hand — not yet observed',
        budgetLineId: null,
        paidElsewhere: null,
      } satisfies Series
    })
}

