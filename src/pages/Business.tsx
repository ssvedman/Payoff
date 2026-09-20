import { useMemo, type ReactNode } from 'react'
import BusinessBars, { type BarMonth } from '../components/BusinessBars'
import TrendChart from '../components/TrendChart'
import { useBusinessMonths } from '../lib/businessMonths'
import { useData, useNetWorth, type Account } from '../lib/data'
import {
  isCurrentMonth,
  type CostCategory,
  type MonthBucket,
  type NamedTotal,
  type PayerKey,
} from '../lib/business'
import {
  MONTH_NAMES,
  money,
  moneyCents,
  parseDateOnly,
  relativeTime,
  signedAmount,
} from '../lib/format'

/**
 * /business — what the business took in, what it spent, and what the household
 * drew out of it.
 *
 * WHY THIS PAGE EXISTS. The business funds roughly a third of household income
 * and had no screen at all. Its checking account runs close to empty every month
 * because whatever is left after costs is drawn out, so the first warning of a
 * quiet month would have been a payment bouncing rather than a figure on a chart.
 * This page makes that shape visible.
 *
 * It REPORTS. There is no advice here, no suggestion to move money, no
 * encouragement and no exclamation mark. "Business balance $412", never "you
 * should transfer money". The client concentration is stated; what to do about
 * it is not.
 *
 * Colour: amber appears nowhere. It means the current payoff target and this
 * page has no target. Green is money in and steel is money out, the one pairing
 * used here, and it is consistent between the chart, its legend and the IN
 * figure above it.
 *
 * Business money never re-enters household bucket maths. Nothing computed on
 * this page reaches a household bucket, and the provider has already stripped
 * every business row out of the household's `transactions` by `is_business`,
 * never by owner.
 *
 * Every number is computed from live rows. The mockup's figures for this
 * business disagree with the database, and the database wins.
 */

/**
 * The desktop and mobile splits, which the mockup draws as two different pages.
 *
 * These three rules belong in index.css beside .acct-sub-wide and .act-date, at
 * the same 1024px breakpoint the shell uses. They live here because index.css is
 * shared with seven other pages and this rebuild must not touch it. Written as
 * CSS rather than as a matchMedia hook for the reason Sidebar.tsx gives: a class
 * that is always in the DOM cannot flicker on first paint.
 *
 * The two layouts differ in substance, not only in arrangement. Desktop gets
 * twelve bars whose month labels need the width; a phone gets the same six
 * months as figures, because at 700 drawing units those labels land near 4px.
 */
/** How many months the chart and the by-month table report. */
const SHOWN_MONTHS = 6

/** Below this, the balance is worth stating as a figure of its own. */
const LOW_BALANCE = 500

/**
 * What to call the business at the top of the page.
 *
 * The mockup writes the trading name straight into the markup. This does not,
 * for the same reason business.ts reads the business's own name out of
 * payment_aliases rather than writing it in source: this repository is public,
 * and a name typed into a file is also a rule that silently stops working when
 * the alias behind it is edited.
 *
 * The aliases are bank descriptors, so most of them are references rather than
 * names. The one wanted here reads like a name: two or more words, letters
 * rather than digits, and none of the wording a payment descriptor carries.
 *
 * The fallback is a CASH account's nickname, not businessAccounts[0]. That array
 * is `accounts.filter(is_business)` in the provider's own order, so the first
 * entry is as likely to be the business card as the checking account, and the
 * page would have been titled after a credit card.
 */
function businessTitle(accounts: Account[]): string {
  const candidates = accounts
    .flatMap((a) => a.payment_aliases ?? [])
    .map((s) => s.trim())
    .filter(
      (s) =>
        s.length >= 6 &&
        s.length <= 40 &&
        s.includes(' ') &&
        /^[A-Za-z0-9 &'.-]+$/.test(s) &&
        !/\b(payment|transfer|ending|acct|account|trace|ind name)\b/i.test(s),
    )
    .sort((a, b) => b.length - a.length)

  const name = candidates[0]
  if (name) {
    return name
      .split(' ')
      .map((w) => (w.length > 1 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
      .join(' ')
  }
  const cash = accounts.find((a) => a.kind === 'checking' || a.kind === 'savings')
  return cash?.name ?? accounts[0]?.name ?? 'Business'
}

/** "September · day 22" — the period every figure on this page is read against. */
function periodLabel(now = new Date()): string {
  return `${MONTH_NAMES[now.getMonth()]} · day ${now.getDate()}`
}

/**
 * Which month a breakdown covers, named on the box itself.
 *
 * A running month is labelled "so far", because a table of 22 days beside a
 * heading that says nothing would read as a finished month.
 */
function periodOf(month: MonthBucket | null, current: boolean): string {
  if (!month) return 'no month on record'
  return current ? `${month.longLabel} so far` : month.longLabel
}

/** A caption and a figure in a soft card, as the three-across desktop row wants them. */
function Stat({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="stat">
      <div className="caps">{label}</div>
      <div
        className={`tnum${good ? ' is-good' : ''}`}
        style={{ fontSize: 24, fontWeight: 800, marginTop: 2, lineHeight: 1.15 }}
      >
        {value}
      </div>
    </div>
  )
}

/**
 * A heading inside a box, with the period it covers beneath it.
 *
 * `.sect` carries a top margin a box does not want, so it is zeroed here rather
 * than a second heading class being invented.
 */
function BoxTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div style={{ marginBottom: 7 }}>
      <div className="sect" style={{ margin: 0 }}>
        {children}
      </div>
      {sub && <div className="tiny muted">{sub}</div>}
    </div>
  )
}

export default function Business() {
  const { businessAccounts, lastSyncedAt, loading: dataLoading, error: dataError } = useData()
  const { debtTotal } = useNetWorth()
  const view = useBusinessMonths()
  const summary = view.summary

  /**
   * The business's cash, and the business's debt, kept apart.
   *
   * `checking` in the shared provider is household-only now, so the business
   * balance has to come from businessAccounts — the same rule in reverse:
   * business money never enters household maths, and household screens never
   * show this figure.
   */
  const cash = useMemo(
    () => businessAccounts.filter((a) => a.kind === 'checking' || a.kind === 'savings'),
    [businessAccounts],
  )
  const cards = useMemo(() => businessAccounts.filter((a) => a.kind === 'card'), [businessAccounts])

  const cashTotal = cash.reduce((s, a) => s + a.balance, 0)
  const cardTotal = cards.reduce((s, a) => s + Math.max(0, a.balance), 0)
  const cashAsOf = cash.map((a) => a.balanceAsOf).filter(Boolean).sort().pop() ?? null

  const title = useMemo(() => businessTitle(businessAccounts), [businessAccounts])

  /**
   * The month the stat cards and both breakdown boxes report.
   *
   * The latest month with rows on it, which is the current month whenever
   * anything has been recorded this month. Falling back to the previous one
   * rather than reporting zeroes matters on the first of the month: a business
   * that has not been paid yet today is not a business with no revenue, and the
   * page says which month it is showing when it is not this one.
   */
  const focus: MonthBucket | null = useMemo(() => {
    if (!summary || summary.months.length === 0) return null
    return summary.months[summary.months.length - 1]
  }, [summary])

  const focusIsCurrent = focus !== null && isCurrentMonth(focus.key)

  /** The last six months, oldest first. The chart and the table read the same six. */
  const recent = useMemo(
    () => (summary ? summary.months.slice(-SHOWN_MONTHS) : []),
    [summary],
  )

  const bars: BarMonth[] = useMemo(
    () =>
      recent.map((m) => ({
        key: m.key,
        label: m.label,
        longLabel: m.longLabel,
        moneyIn: m.moneyIn,
        moneyOut: m.moneyOut,
        current: isCurrentMonth(m.key),
        partial: m.partial,
      })),
    [recent],
  )

  if (dataLoading || view.loading) {
    return (
      <div className="page">
        {/* The same shape the loaded page has: a header, a row of figures, then
            a chart above two boxes. The page does not reflow around the reader
            when the rows land. */}
        <div className="skeleton" style={{ height: 34, width: 220, marginTop: 8 }} aria-label="Loading" />
        <div className="g3" style={{ marginTop: 14 }}>
          <div className="skeleton" style={{ height: 66 }} aria-hidden="true" />
          <div className="skeleton" style={{ height: 66 }} aria-hidden="true" />
          <div className="skeleton" style={{ height: 66 }} aria-hidden="true" />
        </div>
        <div className="skeleton" style={{ height: 170, marginTop: 14 }} aria-hidden="true" />
      </div>
    )
  }

  const error = dataError ?? view.error
  if (error) {
    return (
      <div className="page">
        <div className="ph">Business</div>
        <div className="rule" style={{ marginTop: 10 }}>
          Could not load the business record. {error}
        </div>
      </div>
    )
  }

  if (businessAccounts.length === 0 || !summary) {
    return (
      <div className="page">
        <div className="ph">Business</div>
        <div className="sm muted" style={{ marginTop: 8 }}>
          No business accounts are linked.
        </div>
      </div>
    )
  }

  const inValue = focus ? money(focus.moneyIn) : money(0)
  const outValue = focus ? money(focus.moneyOut) : money(0)
  const whereRows = focus ? whereItGoes(focus, summary.categories) : []
  const clientRows = focus ? revenueByClient(focus, summary.payers) : []
  const concentration = clientRows.length > 0 ? concentrationOf(clientRows) : null

  const accountLine = (
    <div className="tiny muted">
      {cash.map((a) => a.name).join(', ') || 'no cash account'}
      {cashAsOf &&
        ` · as of ${parseDateOnly(cashAsOf).toLocaleDateString('en-US', {
          day: 'numeric',
          month: 'short',
        })}`}
    </div>
  )

  return (
    <div className="page">

      {/* ---------------------------------------------------------------- */}
      {/* Header                                                            */}
      {/* ---------------------------------------------------------------- */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 12,
          marginTop: 8,
          marginBottom: 13,
        }}
      >
        <div>
          <div className="ph">{title}</div>
          {/* "day 22" is a figure like any other, so it is tabular too. A
              proportional 1 here shifts the whole line as the month runs. */}
          <div className="sm muted tnum">{periodLabel()}</div>
        </div>
        <div className="tiny muted tnum" style={{ whiteSpace: 'nowrap' }}>
          {lastSyncedAt ? `synced ${relativeTime(lastSyncedAt)}` : 'never synced'}
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* The balance, and the month's two sides                            */}
      {/* ---------------------------------------------------------------- */}
      <div className="biz-wide">
        <div className="g3">
          <div className="stat">
            <div className="caps">BALANCE</div>
            <div
              className="tnum"
              style={{ fontSize: 24, fontWeight: 800, marginTop: 2, lineHeight: 1.15 }}
            >
              {money(cashTotal)}
            </div>
            {accountLine}
          </div>
          <Stat label="IN THIS MONTH" value={inValue} good />
          <Stat label="OUT" value={outValue} />
        </div>
      </div>

      <div className="biz-narrow">
        {/* The one dominant figure on the page, stated in the page's own colour
            at the page's largest size rather than in the ink hero panel. The
            business balance is an observation, not a target, and this page has
            no plan to measure anything against. */}
        <div
          className="tnum"
          style={{ fontSize: 34, fontWeight: 800, letterSpacing: '-.03em', lineHeight: 1.05 }}
        >
          {money(cashTotal)}
        </div>
        <div className="sm muted">in the account</div>
        {accountLine}
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <div className="stat" style={{ flex: 1 }}>
            <div className="caps">IN</div>
            <div className="tnum is-good" style={{ fontSize: 18, fontWeight: 800, marginTop: 2 }}>
              {inValue}
            </div>
          </div>
          <div className="stat" style={{ flex: 1 }}>
            <div className="caps">OUT</div>
            <div className="tnum" style={{ fontSize: 18, fontWeight: 800, marginTop: 2 }}>
              {outValue}
            </div>
          </div>
        </div>
      </div>

      {focus && !focusIsCurrent && (
        <div className="rule">
          Nothing has been recorded on a business account this month. The two figures above are{' '}
          {focus.longLabel}.
        </div>
      )}

      {!focus && (
        <div className="rule">
          No business transaction has been recorded in the window this page reads. The balance is
          still the bank's.
        </div>
      )}

      {/*
        A fact, and then a full stop. A balance below the floor is worth stating
        as a figure; what to do with it is not this page's business.
      */}
      {cashTotal < LOW_BALANCE && (
        <div className="rule">
          {/* Ink, not red. Below the floor is worth stating; it is not a
              deviation from a plan this page does not hold. */}
          The balance is <span className="tnum" style={{ fontWeight: 700 }}>{moneyCents(cashTotal)}</span>, below{' '}
          <span className="tnum">{money(LOW_BALANCE)}</span>.
        </div>
      )}

      {/*
        Said in words because no chart can say it. The business card is a
        business debt AND one of the accounts in the household payoff queue, so
        the same balance appears on two screens. Without this line a reader who
        has seen both would reasonably conclude the household owes it twice.
      */}
      {cardTotal > 0 && (
        <div className="rule">
          <span className="tnum">{moneyCents(cardTotal)}</span> on the business card
          {cards.length > 1 ? 's' : ''} is also inside the household payoff queue and inside the{' '}
          <span className="tnum">{money(debtTotal)}</span> total debt. It is one balance shown in two
          places, not two debts.
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* In and out, by month                                              */}
      {/* ---------------------------------------------------------------- */}
      <div className="biz-wide">
        <div className="box" style={{ marginTop: 15 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              gap: 12,
              marginBottom: 10,
            }}
          >
            <BoxTitle>In and out, by month</BoxTitle>
            {summary.breakEvenRun >= 3 && (
              <div className="tiny muted">
                net within <span className="tnum">{money(summary.breakEvenBand)}</span> of zero for{' '}
                <span className="tnum">{summary.breakEvenRun}</span> months
              </div>
            )}
          </div>
          <BusinessBars months={bars} />
        </div>
      </div>

      <div className="biz-narrow">
        <div className="sect">Net, by month</div>
        <table className="tbl">
          <tbody>
            {recent.map((m) => (
              <tr key={m.key}>
                <td style={isCurrentMonth(m.key) ? { fontWeight: 700 } : undefined}>
                  {m.label}
                  {m.partial && <span className="tiny muted"> {'·'} part</span>}
                  {isCurrentMonth(m.key) && <span className="tiny muted"> {'·'} so far</span>}
                </td>
                {/*
                  No colour. Green means on plan and red means a deviation, and
                  the business has no plan to deviate from: this page exists to
                  observe, not to grade. A month that ended down is a fact about
                  the month, not a failure against a target that was never set.

                  Direction is carried by an arrow and by the sign the figure
                  already has, which says the same thing without borrowing a
                  meaning from the household pages. The desktop chart makes the
                  point a third way, by which of the two bars is taller.
                */}
                <td
                  className="num tnum"
                  style={isCurrentMonth(m.key) ? { fontWeight: 700 } : undefined}
                >
                  <span className="muted" aria-hidden="true">
                    {m.net >= 0 ? '↑' : '↓'}{' '}
                  </span>
                  {signedAmount(m.net, money)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/*
        The finding this page was built for, stated as a measurement rather than
        as a claim: how many consecutive complete months landed within $500 of
        break-even, how wide that band actually was, and on how much throughput.
        Derived every render, so it stays true as months are added.
      */}
      {summary.breakEvenRun >= 3 && (
        <div className="rule">
          The last <span className="tnum">{summary.breakEvenRun}</span> complete months each ended
          within <span className="tnum">{moneyCents(summary.breakEvenBand)}</span> of break-even, on
          an average <span className="tnum">{money(summary.runThroughput)}</span> a month coming in.
          Costs and the draw together take close to whatever arrives, so the closing balance carries
          little from one month to the next.
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Who pays, and where it goes                                       */}
      {/* ---------------------------------------------------------------- */}
      <div className="g2" style={{ marginTop: 15 }}>
        <div className="box">
          <BoxTitle sub={periodOf(focus, focusIsCurrent)}>Revenue by client</BoxTitle>

          {clientRows.length === 0 ? (
            <div className="sm muted">No client payment is recorded for this month.</div>
          ) : (
            <table className="tbl">
              <tbody>
                {clientRows.map((r) => (
                  <tr key={r.key}>
                    <td className={r.isOther ? 'muted' : undefined}>
                      {r.label}
                      {r.note && <span className="tiny muted"> {r.note}</span>}
                    </td>
                    <td className="num">{money(r.total)}</td>
                    <td className="num tiny muted" style={{ width: 44 }}>
                      {r.share}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {concentration && (
            <div className="rule">
              <span className="tnum">{concentration.clients}</span>{' '}
              {concentration.clients === 1 ? 'client accounts' : 'clients account'} for{' '}
              <span className="tnum">{concentration.share}%</span> of revenue.
            </div>
          )}

          {/*
            Stated because the table cannot: money arriving on the business
            account is not all revenue. The household funds the business too, and
            those rows sit under the same TRANSFER_IN category as everything else.
          */}
          {focus && focus.fromHousehold > 0 && (
            <div className="rule">
              A further <span className="tnum">{moneyCents(focus.fromHousehold)}</span> arrived from
              household accounts. That is the household funding the business, so it is counted
              separately from revenue.
            </div>
          )}

          {focus && focus.refunds > 0 && (
            <div className="rule">
              <span className="tnum">{moneyCents(focus.refunds)}</span> of refunds came back and is
              counted as money in, not as a negative cost.
            </div>
          )}

          {/*
            The other half of the untracked-account pair, and the reason it is
            stated rather than netted. Money arriving from an account this app
            does not track is not revenue: nobody paid for work. Netting it
            against the money that went out to the same place would report one
            movement that never happened, which is why business.ts keeps the two
            legs apart.
          */}
          {focus && focus.fromOutside > 0 && (
            <div className="rule">
              <span className="tnum">{moneyCents(focus.fromOutside)}</span> came back from an account
              this app does not track. It is counted as money in, not as revenue.
            </div>
          )}
        </div>

        <div className="box">
          <BoxTitle sub={periodOf(focus, focusIsCurrent)}>Where it goes</BoxTitle>

          {whereRows.length === 0 ? (
            <div className="sm muted">Nothing left a business account in this month.</div>
          ) : (
            <table className="tbl">
              <tbody>
                {whereRows.map((r) => (
                  <tr key={r.key}>
                    <td>
                      {r.label}
                      {r.note && <span className="tiny muted"> {r.note}</span>}
                    </td>
                    <td className="num">{money(r.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/*
            Two things a reader would otherwise get wrong, and both cost real
            money.
          */}
          {focus && focus.draw > 0 && (
            <div className="rule">
              The draw is counted from the business side only. Every transfer to household checking
              also appears on the household side as an arriving transfer already bucketed as income,
              and adding both legs would double it. The household side is also incomplete: money that
              paid a household card directly, or reached a person by Zelle, never touched household
              checking and would be missing from it entirely.
            </div>
          )}

          {/*
            Why "an account not tracked here" is a line of its own rather than
            part of the draw. The descriptor names a mask that belongs to none of
            our accounts, so the money genuinely left the business but did not
            reach the household. Calling it a draw would overstate what the
            household received; dropping it would lose the money from the page
            with nothing on screen to say so.
          */}
          {focus && focus.toOutside > 0 && (
            <div className="rule">
              <span className="tnum">{moneyCents(focus.toOutside)}</span> went to an account this app
              does not track. It left the business, so it is listed above, but it is not a draw: it
              never reached a household account.
            </div>
          )}

          {focus && focus.internalOut > 0 && (
            <div className="rule">
              <span className="tnum">{moneyCents(focus.internalOut)}</span> moved from the business's
              checking to its own card. It is not listed above, because the purchases it settles are
              already counted as costs.
            </div>
          )}

          {/*
            The reconciliation, stated rather than promised. Every dollar out
            lands in exactly one line above, which is what makes the table an
            answer to "where does it go" instead of a sample of it. Kept as a
            derived comparison so a drift shows its size rather than going
            unnoticed.
          */}
          {focus && whereRows.length > 0 && (
            <div className="rule">
              {Math.abs(sumRows(whereRows) - (focus.moneyOut - focus.internalOut)) < 0.01 ? (
                <>
                  The lines above add to{' '}
                  <span className="tnum">{moneyCents(sumRows(whereRows))}</span>, which is everything
                  that left the account this month
                  {focus.internalOut > 0 && ' other than the transfer to its own card'}. Nothing is
                  left out of the breakdown.
                </>
              ) : (
                <>
                  The lines above add to{' '}
                  <span className="tnum">{moneyCents(sumRows(whereRows))}</span> against{' '}
                  <span className="tnum">{moneyCents(focus.moneyOut - focus.internalOut)}</span> that
                  left the account.
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Balance readings                                                  */}
      {/* ---------------------------------------------------------------- */}
      <div className="sect">Balance readings</div>
      <BalanceReadings readings={view.cashReadings} />

      <div className="rule" style={{ marginTop: 16 }}>
        Business rows never enter a household budget bucket, and nothing on this page is part of the
        household's income, spending or payoff maths.
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The two breakdown tables
// ---------------------------------------------------------------------------

interface ClientRow {
  key: string
  label: string
  total: number
  /** Whole percent of the month's revenue. */
  share: number
  isOther: boolean
  /**
   * What the row actually matched on, shown for "Other payers" only.
   *
   * Without it "Other payers" reads as a client called Other. It is the deposits
   * whose ACH company name matched no payer rule, which is exactly the figure a
   * reader needs to be able to interpret before trusting the percentages above
   * it.
   */
  note?: string
}

/**
 * Who paid, this month, largest first.
 *
 * Clients whose total is zero are dropped rather than listed at $0: a client
 * that invoices monthly and has not yet been paid is not a client who paid
 * nothing. "Other payers" is kept whenever it is non-zero, because a deposit no
 * rule matched is exactly the figure a reader needs to see.
 */
function revenueByClient(
  month: MonthBucket,
  payers: (NamedTotal<PayerKey> & { descriptor: string })[],
): ClientRow[] {
  const total = month.revenue
  if (total <= 0) return []

  return payers
    .map((p) => ({
      key: p.key,
      label: p.label,
      total: month.revenueByPayer[p.key] ?? 0,
      share: Math.round(((month.revenueByPayer[p.key] ?? 0) / total) * 100),
      isOther: p.key === 'other',
      note: p.key === 'other' ? p.descriptor : undefined,
    }))
    .filter((r) => r.total > 0)
    .sort((a, b) => {
      // Other last whatever its size, because it is not a client.
      if (a.isOther !== b.isOther) return a.isOther ? 1 : -1
      return b.total - a.total
    })
}

/**
 * How concentrated the revenue is, counted rather than asserted.
 *
 * The fewest named clients that between them cover REVENUE_CONCENTRATION of the
 * month, and what they actually add to. Reported and left there: this page does
 * not suggest finding more clients.
 */
const REVENUE_CONCENTRATION = 0.9

function concentrationOf(rows: ClientRow[]): { clients: number; share: number } | null {
  const clients = rows.filter((r) => !r.isOther)
  if (clients.length === 0) return null

  const total = rows.reduce((s, r) => s + r.total, 0)
  if (total <= 0) return null

  let taken = 0
  let n = 0
  for (const c of clients) {
    taken += c.total
    n += 1
    if (taken / total >= REVENUE_CONCENTRATION) break
  }
  return { clients: n, share: Math.round((taken / total) * 100) }
}

interface OutRow {
  key: string
  label: string
  note?: string
  total: number
}

const sumRows = (rows: OutRow[]) => rows.reduce((s, r) => s + r.total, 0)

/**
 * Every dollar that left the business this month, largest first.
 *
 * The draw is a line here rather than a section of its own. It is money leaving
 * the business exactly as labour and insurance are, and separating it invited
 * the reading that the business's costs are what the business spends and the
 * draw is something else.
 *
 * Sorted by size, which COST_ORDER deliberately is not. That order exists so a
 * category keeps its colour as the ranking moves; nothing in this table is
 * coloured, and a list answering "where does it go" that is not in order of
 * size answers a different question.
 *
 * Internal transfers are absent on purpose: the business paying its own card is
 * not a cost, and the purchases it settles are already counted as one. Money
 * sent to an account this app does not track IS listed, because it genuinely
 * left.
 */
function whereItGoes(month: MonthBucket, categories: NamedTotal<CostCategory>[]): OutRow[] {
  const rows: OutRow[] = categories
    .map((c) => ({
      key: c.key as string,
      label: c.label,
      total: month.costsByCategory[c.key] ?? 0,
    }))
    .filter((r) => r.total > 0)

  if (month.draw > 0) {
    rows.push({ key: 'draw', label: 'The draw', note: 'to household', total: month.draw })
  }
  if (month.toOutside > 0) {
    rows.push({
      key: 'outside',
      label: 'An account not tracked here',
      note: 'not a draw',
      total: month.toOutside,
    })
  }

  return rows.sort((a, b) => b.total - a.total)
}

// ---------------------------------------------------------------------------
// Balance readings
// ---------------------------------------------------------------------------

/**
 * The balance history, said honestly.
 *
 * The business checking account has five readings, all inside four days, because
 * that is when it was linked. Drawing a line through them would look like a trend
 * and be nothing of the kind, and reconstructing the earlier months from
 * transactions would be inventing a record the bank never gave us. So: below a
 * fortnight of readings this lists what was actually recorded and says how many
 * there are; above it, the same trend line the rest of the app uses.
 */
function BalanceReadings({ readings }: { readings: { as_of: string; balance: number }[] }) {
  if (readings.length === 0) {
    return <div className="sm muted">No balance has been recorded for the business yet.</div>
  }

  const first = parseDateOnly(readings[0].as_of)
  const last = parseDateOnly(readings[readings.length - 1].as_of)
  const spanDays = Math.round((last.getTime() - first.getTime()) / 86400000)
  const fmtDay = (iso: string) =>
    parseDateOnly(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })

  const note = (
    <div className="rule">
      <span className="tnum">{readings.length}</span>{' '}
      {readings.length === 1 ? 'reading' : 'readings'} since {fmtDay(readings[0].as_of)}
      {spanDays > 0 && (
        <>
          {' · '}
          <span className="tnum">{spanDays}</span> {spanDays === 1 ? 'day' : 'days'}
        </>
      )}
      . Nothing was recorded before the account was linked, and no earlier history is reconstructed
      here.
    </div>
  )

  // Too short a span to be a trend. Show the readings themselves.
  if (spanDays < 14 || readings.length < 8) {
    return (
      <div style={{ maxWidth: 460 }}>
        <table className="tbl">
          <tbody>
            {readings.map((r) => (
              <tr key={r.as_of}>
                <td className="tnum muted">{fmtDay(r.as_of)}</td>
                <td className="num">{moneyCents(r.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {note}
      </div>
    )
  }

  return (
    <div>
      <TrendChart
        points={readings.map((r) => ({ date: r.as_of, value: r.balance }))}
        color="var(--steel)"
        format={moneyCents}
        label="Business cash balance"
        baseline="zero"
      />
      {note}
    </div>
  )
}
