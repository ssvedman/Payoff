import { useData, useNetWorth } from '../lib/data'
import { accountLabel, moneyCents, parseDateOnly, signedAmount } from '../lib/format'

/**
 * The balance sheet: everything owned, less everything owed.
 *
 * Home's headline is the debt total, which only ever gets better by getting
 * smaller — it says nothing about what the household actually has. This says the
 * other half, and today it says it is negative. That is deliberate and it is not
 * softened: a figure that only appears once it is flattering is not a report.
 *
 * Every figure comes from useNetWorth(), which sums the account rows by kind.
 * Nothing here may be re-derived from plan.totalOwed — that counts only debts
 * which are not cleared, and `cleared` is true the moment cleared_at is set even
 * with a balance still on the account. Such a debt would drop out of net worth
 * while the household still owed it.
 */

/** "Sep 15, 2026" — a valuation is only as good as its date, so the date shows. */
function valuedOn(dateStr: string): string {
  return parseDateOnly(dateStr).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export default function NetWorthPanel() {
  const { assetsTotal, cashTotal, businessCash, debtTotal, netWorth, assetRows, hasAssets } =
    useNetWorth()
  const { businessAccounts, assetsError } = useData()

  /**
   * Named, not summarised. The business's card is inside the debt total above,
   * so the business's cash has to be inside the cash total — and both facts are
   * stated rather than left to be discovered. Read off the rows instead of
   * spelled out in the copy: an account renamed at the bank must not be able to
   * make this sentence a lie.
   */
  const businessDebts = businessAccounts.filter(
    (a) => a.kind !== 'checking' && a.kind !== 'savings' && a.balance > 0,
  )
  const businessDebtNames = businessDebts.map((a) => a.name).join(' and ')

  return (
    <div className="card-panel" style={{ marginBottom: 20 }}>
      <div className="caps" style={{ marginBottom: 6 }}>NET WORTH</div>

      {/* A failed assets read leaves the same empty array an empty table would,
          so net worth would compute as cash-minus-debt: −$116,090 instead of
          −$52,348, with no sign that $63,742 of vehicles simply never arrived.
          A banner over a confidently wrong figure is barely better than the
          figure alone — the reader takes the big number and skims the small
          type — so the figure itself is withheld below, not annotated. */}
      {assetsError && (
        <div className="banner banner--red tiny" style={{ marginBottom: 10 }}>
          Assets could not be loaded, so net worth cannot be stated. Cash and debt
          below are real; what is owned is missing.
        </div>
      )}

      {/*
        signedAmount(), never signedMoney(). signedMoney exists for Plaid
        transaction amounts, where a POSITIVE number is money going OUT, so it
        flips every sign it is given — it would print this figure as a positive
        net worth and the truck as +$4,702.37, an underwater vehicle reported as
        equity. U+2212 is a real minus sign, not a hyphen: at this size a hyphen
        reads as a dash between words.
      */}
      <div
        className="tnum"
        style={{
          fontSize: 32,
          fontWeight: 800,
          letterSpacing: '-.03em',
          lineHeight: 1.1,
          color: assetsError ? 'var(--steel)' : netWorth < 0 ? 'var(--red)' : 'var(--ink)',
        }}
      >
        {assetsError ? '—' : signedAmount(netWorth)}
      </div>

      <div className="tiny muted" style={{ marginTop: 4, lineHeight: 1.5 }}>
        {assetsError
          ? 'What is owned less what is owed — half of it did not load, so no figure is given.'
          : 'What is owned less what is owed. It rises as the debt falls.'}
      </div>

      {/*
        To the cent, like the headline. Rounded to whole dollars these three
        lines stop visibly adding up to the figure above them — assets plus cash
        less debt lands two dollars out — and a balance sheet whose own
        arithmetic looks wrong on screen is not worth printing.

        Assets prints "unavailable", never $0.00: zero is a claim about what is
        owned, and it is the same false claim the withheld headline exists to
        avoid. Cash and debt did load, so they are stated.
      */}
      <div style={{ marginTop: 12, borderTop: '1px solid var(--line)' }}>
        <Line label="Assets" value={assetsError ? 'unavailable' : moneyCents(assetsTotal)} />
        <Line label="Cash" value={moneyCents(cashTotal)} />
        <Line label="Debt" value={`−${moneyCents(debtTotal)}`} />
      </div>

      {(businessCash > 0 || businessDebts.length > 0) && (
        <div className="tiny muted" style={{ marginTop: 9, lineHeight: 1.55 }}>
          Both sides include the business:{' '}
          <span className="tnum">{moneyCents(businessCash)}</span> of business cash
          {businessDebtNames ? ` and the ${businessDebtNames} card` : ''}. Counting the
          business's card but not its cash would overstate what is owed.
        </div>
      )}

      {hasAssets && (
        <div style={{ marginTop: 14 }}>
          <div className="caps" style={{ marginBottom: 2 }}>EQUITY BY VEHICLE</div>

          {assetRows.map((r) => {
            const under = r.equity < 0
            return (
              <div
                key={r.asset.id}
                style={{ padding: '9px 0', borderBottom: '1px solid var(--line)' }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="sm" style={{ fontWeight: 600 }}>
                      {r.asset.name}
                    </div>
                    {/*
                      The securing loan comes off the row's own `loan`, matched by
                      uuid inside useNetWorth. Never matched by name: the truck's
                      loan is called "Truck — Issuer" with an em dash, and a
                      name match reports a truck that is $4,702.37 underwater as
                      owned outright.
                    */}
                    <div className="tiny muted tnum">
                      {moneyCents(r.asset.estimated_value)}
                      {r.loan
                        ? ` · against ${accountLabel(r.loan)} ${moneyCents(r.owedOn)}`
                        : ' · owned outright'}
                    </div>
                    <div className="tiny muted tnum">valued {valuedOn(r.asset.valued_on)}</div>
                  </div>

                  {/* Green is cleared or on plan, red is a deviation. Never amber:
                      amber is the current payoff target and nothing else. */}
                  <div
                    className="tnum sm"
                    style={{
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                      color: under ? 'var(--red)' : 'var(--green)',
                    }}
                  >
                    {signedAmount(r.equity)}
                  </div>
                </div>

                {/*
                  Stated in words on the row itself rather than left to the minus
                  sign. This is the single fact the panel exists to surface, and a
                  red figure among four figures is easy to read past.
                */}
                {under && (
                  <div className="tiny tnum" style={{ color: 'var(--red)', marginTop: 3 }}>
                    {moneyCents(Math.abs(r.equity))} more owed on it than it is worth.
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** One line of the breakdown. Label left, figure right, borders between. */
function Line({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        padding: '7px 0',
        borderBottom: '1px solid var(--line)',
      }}
    >
      <span className="sm muted">{label}</span>
      <span className="tnum sm" style={{ fontWeight: 600 }}>
        {value}
      </span>
    </div>
  )
}
