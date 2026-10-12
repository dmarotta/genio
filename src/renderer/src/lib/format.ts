export function ago(iso?: string, now = Date.now()): string {
  if (!iso) return '—'
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000)
  if (s < 45) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`
  return `${Math.floor(s / 86400)}d`
}

export function elapsed(iso?: string, now = Date.now()): string {
  if (!iso) return '00:00'
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const p = (n: number): string => String(n).padStart(2, '0')
  return h ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`
}

export function clock(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function dateShort(iso?: string): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
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

/** yyyy-mm-dd for <input type=date> */
export function dateInput(iso?: string): string {
  if (!iso) return ''
  return iso.slice(0, 10)
}

export function shortPath(p: string, keep = 2): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length <= keep ? p : '…/' + parts.slice(-keep).join('/')
}
