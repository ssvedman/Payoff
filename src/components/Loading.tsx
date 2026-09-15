/**
 * Shown while the session or membership is still resolving.
 * Deliberately contains no figures, dates or names — nothing renders before auth.
 */
export default function Loading() {
  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div className="skeleton" style={{ width: 96, height: 10 }} aria-label="Loading" />
    </div>
  )
}
