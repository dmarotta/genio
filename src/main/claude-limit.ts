import type { ClaudeRateLimitInfo } from './usage'

export const isClaudeLimit = (text: string): boolean => /(?:hit|reached|exceeded).*?(?:session|usage|rate|weekly|plan).*?limit|(?:usage|rate|session|weekly) limit (?:reached|exceeded)|rate_limit/i.test(text)

/** CLI clock-only reset times refer to today in the reported zone, even when already past. */
export function claudeResetTime(text: string, now = Date.now()): number | undefined {
  const reset = /resets?\s+(?:at\s+)?(.+)/i.exec(text)?.[1]
  if (!reset) return undefined
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/i.exec(reset)?.[0]
  if (iso) {
    const ms = Date.parse(iso)
    return Number.isFinite(ms) ? ms : undefined
  }
  const match = /^(?:(today|tomorrow)\s+(?:at\s+)?|([a-z]{3,9})\s+(\d{1,2})(?:,?\s+(\d{4}))?(?:,|\s+at)?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?![\d:])(?:\s*\(([^)]+)\))?/i.exec(reset)
  if (!match) return undefined
  let hour = Number(match[5])
  const minute = Number(match[6] ?? 0)
  if (minute > 59 || hour > (match[7] ? 12 : 23) || (match[7] && hour < 1)) return undefined
  if (match[7]) hour = hour % 12 + (match[7].toLowerCase() === 'pm' ? 12 : 0)
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: match[8], year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    const parts = (ms: number): Record<string, number> => Object.fromEntries(fmt.formatToParts(ms).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]))
    const d = parts(now)
    const month = match[2] ? ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(match[2].slice(0, 3).toLowerCase()) : d.month - 1
    const day = match[3] ? Number(match[3]) : d.day
    if (month < 0 || day < 1 || day > 31) return undefined
    const wall = Date.UTC(Number(match[4] ?? d.year), month, day + (match[1]?.toLowerCase() === 'tomorrow' ? 1 : 0), hour, minute)
    let utc = wall
    for (let i = 0; i < 3; i++) {
      const p = parts(utc)
      utc += wall - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
    }
    return utc
  } catch { return undefined }
}

export function claudeLimitState(text: string, latest?: ClaudeRateLimitInfo, now = Date.now()): { stale: boolean; resetsAt?: number } {
  const epoch = latest?.resetsAt
  const parsed = claudeResetTime(text, now)
  const resetsAt = parsed ?? (typeof epoch === 'number' && Number.isFinite(epoch) ? epoch * 1000 : undefined)
  return { resetsAt, stale: (parsed === undefined && latest?.status === 'allowed') || (resetsAt !== undefined && resetsAt <= now) }
}
