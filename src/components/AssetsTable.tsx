import { useData, useNetWorth } from '../lib/data'
import { accountLabel, moneyCents, parseDateOnly, signedAmount } from '../lib/format'
import EditAsset from './EditAsset'

/**
 * VEHICLES on /accounts — what is owned, and what is still owed against it.
 *
 * It sits below the Save-balances button rather than among the three tables
 * above it. Those tables and that button are one thing: the button saves a
 * balance snapshot for every manual ACCOUNT whose input changed, keyed on the
 * page's values/seed maps. An asset is not an account and has no snapshot, so an
 * asset id in those maps could never appear in the dirty diff — its edits would
 * be silently unsaveable under a button that says it saves them. Assets save
 * themselves, one row at a time, through EditAsset.
 */

/** "Sep 15, 2026". valued_on is a DATE column, so parseDateOnly, never new Date(). */
function valuedOn(dateStr: string): string {
  return parseDateOnly(dateStr).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export default function AssetsTable({ onSaved }: { onSaved: () => void | Promise<void> }) {
  // The same hook the Home panel reads, so the two screens cannot disagree about
  // what a vehicle is worth or what is owed on it. Each row's loan is already
  // resolved by uuid in there — matching on name would call the truck outright.
  const { assetRows } = useNetWorth()
  const { assetsError } = useData()

  return (
    <>
      <div className="tiny muted" style={{ fontWeight: 700, margin: '20px 0 4px' }}>
        VEHICLES
      </div>
      <div className="tiny muted" style={{ marginBottom: 6, lineHeight: 1.5 }}>
        What is owned, and what is still owed against it. Not part of the payoff
        queue — the loans themselves are listed above.
      </div>

      {assetsError ? (
        /* A failed read is not an empty table. Saying "no vehicles on record"
           about four vehicles that ARE on record is the more confident and the
           more wrong of the two claims. */
        <div className="banner banner--red tiny" style={{ margin: '10px 0' }}>
          Vehicles could not be loaded. {assetsError}
        </div>
      ) : assetRows.length === 0 ? (
        <div className="tiny muted" style={{ padding: '10px 0' }}>
          No vehicles on record.
        </div>
      ) : (
        <table>
          <tbody>
            {assetRows.map((r) => {
              const under = r.equity < 0
              return (
                <tr key={r.asset.id}>
                  <td>
                    <div className="sm" style={{ fontWeight: 600 }}>
                      {r.asset.name}
                    </div>
                    <div className="tiny muted tnum">
                      {[
                        r.loan
                          ? `secured by ${accountLabel(r.loan)} · ${moneyCents(r.owedOn)} owed`
                          : 'owned outright',
                        `valued ${valuedOn(r.asset.valued_on)}`,
                      ].join(' · ')}
                    </div>
                    <EditAsset asset={r.asset} onSaved={onSaved} />
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div className="tnum sm">{moneyCents(r.asset.estimated_value)}</div>
                    {/* signedAmount, not signedMoney: signedMoney is for Plaid
                        transaction amounts and inverts, which would report the
                        the truck as +$4,702.37 of equity. Red for underwater, green
                        for equity — never amber, which is the payoff target. */}
                    <div
                      className="tiny tnum"
                      style={{ color: under ? 'var(--red)' : 'var(--green)', marginTop: 2 }}
                    >
                      {signedAmount(r.equity)} equity
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </>
  )
}
