import { formatDuration } from '@shared/duration'

export function ago(iso?: string, now = Date.now()): string {
  const ms = now - Date.parse(iso ?? '')
  if (!Number.isFinite(ms)) return '—'
  if (ms < 60_000) return 'now'
  return formatDuration(ms, { largestTwoUnits: true, precision: 'minutes' })
}

// One formatter each: toLocale*String builds a new Intl.DateTimeFormat on every call, and a chat or roster
// formats hundreds of timestamps per render. Same options, same output; an invalid date still reads "Invalid Date".
const CLOCK = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' })
const DAY = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' })
const DATE_TIME = new Intl.DateTimeFormat([], { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
const formatted = (f: Intl.DateTimeFormat, d: Date): string => (Number.isNaN(d.getTime()) ? 'Invalid Date' : f.format(d))

export function clock(iso?: string): string {
  if (!iso) return ''
  return formatted(CLOCK, new Date(iso))
}

export function dateShort(iso?: string): string {
  if (!iso) return ''
  return formatted(DAY, new Date(iso))
}

/** Date and time as `toLocaleString()` writes them. */
export function dateTime(at: string | number): string {
  return formatted(DATE_TIME, new Date(at))
}

export function usd(n?: number): string {
  const v = n ?? 0
  return v < 10 ? `$${v.toFixed(2)}` : `$${v.toFixed(0)}`
}

export function trunc(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

export function shortPath(p: string, keep = 2): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length <= keep ? p : '…/' + parts.slice(-keep).join('/')
}
