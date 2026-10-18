export interface DurationOptions {
  /** Coarse displays: allow days and keep only the largest two units. */
  largestTwoUnits?: boolean
  /** Estimates and historical ages can omit seconds. Live clocks use the default. */
  precision?: 'seconds' | 'minutes'
}

/** Milliseconds as "1h 8m 3s"; floor partial seconds and clamp invalid/negative input to zero. */
export function formatDuration(ms: number, options: DurationOptions = {}): string {
  let seconds = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0
  const units: [string, number][] = options.largestTwoUnits
    ? [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]
    : [['h', 3600], ['m', 60], ['s', 1]]
  if (options.precision === 'minutes') units.pop()
  const parts: string[] = []
  for (const [label, size] of units) {
    const value = Math.floor(seconds / size)
    seconds %= size
    if (value || parts.length || size === units.at(-1)![1]) parts.push(`${value}${label}`)
    if (options.largestTwoUnits && parts.length === 2) break
  }
  return parts.join(' ')
}
