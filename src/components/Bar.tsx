/** The 7px progress bar used throughout. Width is clamped to 0–100%. */
export default function Bar({
  pct,
  color,
  track,
  className,
}: {
  pct: number
  color: string
  track?: string
  className?: string
}) {
  const w = Math.max(0, Math.min(100, pct * 100))
  return (
    <div className={`bar${className ? ' ' + className : ''}`} style={track ? { background: track } : undefined}>
      <span style={{ width: `${w}%`, background: color }} />
    </div>
  )
}
