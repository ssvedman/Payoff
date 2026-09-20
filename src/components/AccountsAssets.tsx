import { useData, useNetWorth } from '../lib/data'
import { money, parseDateOnly, signedAmount } from '../lib/format'

/**
 * Assets on /accounts: what is owned, with the loan held against it resolved.
 *
 * Each row is an inline field, and the page's single Save changes button writes
 * every one of them along with the typed-in balances. It used to be a table of
 * read-only figures with a per-row disclosure to edit one, which put an edited
 * valuation in a field that the visible save button could not reach.
 *
 * The valuation date is not decoration. These figures are held flat between
 * updates while the vehicles behind them depreciate, so net worth reads
 * optimistically for as long as they go untouched, which is exactly what the
 * rule beneath the table says.
 */

/** "15 Sep 2026". valued_on is a DATE column, so parseDateOnly, never new Date(). */
function valuedOn(dateStr: string): string {
  return parseDateOnly(dateStr).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export default function AccountsAssets({
  variant,
  values,
  onChange,
}: {
  /** A real table beside Cash on desktop; rows with the field flush right on a phone. */
  variant: 'table' | 'rows'
  values: Record<string, string>
  onChange: (id: string, value: string) => void
}) {
  // The same hook the net worth panel reads, so the two screens cannot disagree
  // about what a vehicle is worth or what is owed on it. Each row's loan is
  // already resolved by uuid in there — matching on name would call the truck
  // owned outright.
  const { assetRows } = useNetWorth()
  const { assetsError } = useData()

  if (assetsError) {
    /* A failed read is not an empty table. Saying "no vehicles on record" about
       four vehicles that ARE on record is the more confident and the more wrong
       of the two claims. */
    return (
      <div className="banner banner--red tiny" style={{ margin: '10px 0' }}>
        Vehicles could not be loaded. {assetsError}
      </div>
    )
  }

  if (assetRows.length === 0) {
    return (
      <div className="tiny muted" style={{ padding: '10px 0' }}>
        No vehicles on record.
      </div>
    )
  }

  /**
   * The span of valuation dates on record.
   *
   * The rule beneath the table names a date, and naming only the NEWEST one
   * would claim every figure above it was checked that day. valued_on is a DATE
   * column, so the strings sort chronologically. Where the dates differ the span
   * is stated, because the oldest is the one that says how far the total can be
   * trusted, and the old per-row "valued 15 Sep 2026" line that said this for
   * each vehicle is not in the new layout to say it.
   */
  const valuedDates = assetRows.map((r) => r.asset.valued_on).sort()
  const oldestValued = valuedDates[0]
  const newestValued = valuedDates[valuedDates.length - 1]
  const valuedPhrase =
    oldestValued === newestValued
      ? `Valued ${valuedOn(newestValued)}`
      : `Valued between ${valuedOn(oldestValued)} and ${valuedOn(newestValued)}`

  /**
   * Equity, green or red.
   *
   * signedAmount, not signedMoney: signedMoney is for Plaid transaction amounts
   * and inverts the sign, which would report the truck as +$4,702 of equity.
   * Red for underwater, green for equity, never amber, which is the payoff
   * target and nothing else.
   */
  const equityLine = (equity: number, owedOn: number) =>
    owedOn === 0 ? (
      <span className="is-good">owned outright</span>
    ) : (
      <span className={`tnum ${equity < 0 ? 'is-bad' : 'is-good'}`}>
        {signedAmount(equity, money)} equity
      </span>
    )

  const field = (id: string, name: string, width: number) => (
    <input
      className="b tnum"
      style={{ width }}
      inputMode="decimal"
      aria-label={`${name} estimated value`}
      value={values[id] ?? ''}
      onChange={(e) => onChange(id, e.target.value)}
    />
  )

  /*
   * The second sentence is the one the old VEHICLES heading carried: a vehicle
   * is not in the payoff queue, and the loan secured on it is a row in Debts
   * above. Without it a reader has no way to know a vehicle appears on this page
   * twice, once as a thing owned and once as a debt, and that the equity line
   * beside it is what reconciles the two.
   */
  const rule = (
    <div className="rule">
      {valuedPhrase} and held flat, so net worth reads optimistically as they
      depreciate. The loans they secure are listed under Debts, so nothing here
      is counted twice.
    </div>
  )

  if (variant === 'rows') {
    return (
      <>
        {assetRows.map((r) => (
          <div className="row" key={r.asset.id}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="sm" style={{ fontWeight: 600 }}>
                {r.asset.name}
              </div>
              <div className="tiny">{equityLine(r.equity, r.owedOn)}</div>
            </div>
            {field(r.asset.id, r.asset.name, 96)}
          </div>
        ))}
        {rule}
      </>
    )
  }

  return (
    <>
      <table className="tbl">
        <tbody>
          {assetRows.map((r) => (
            <tr key={r.asset.id}>
              <td>
                {r.asset.name}
                <div className="tiny">{equityLine(r.equity, r.owedOn)}</div>
              </td>
              <td className="num" style={{ verticalAlign: 'top', width: 124 }}>
                {field(r.asset.id, r.asset.name, 108)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rule}
    </>
  )
}
