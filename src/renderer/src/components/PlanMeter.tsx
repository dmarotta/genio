/**
 * The shared plan meter: one row per plan (Claude, Codex), never summed. Each
 * reported window shows what is left, its reset time, source and observation
 * age; an expired or missing observation reads "unknown", never "100% left".
 * Used full-size in Settings → Usage & limits; the rail shows one gauge icon
 * with the same details in a hover/focus popup.
 */
import { useEffect, useRef, useState } from 'react'
import { leftText, USAGE_MODE_LABEL, type MeterRow, type MeterWindow, type UsagePolicyView } from '@shared/usage-mode'
import { api, useStore } from '../store'
import { ago, cx } from '../lib/format'
import { openSettings } from '../lib/settings-nav'
import { Popover } from './Layer'

const REFRESH_MS = 60_000

/** The cached policy view: on mount, every minute and when settings change. Main reads local evidence only. */
export function useUsagePolicy(): UsagePolicyView | null { return useUsagePolicyState().view }

export function useUsagePolicyState(): { view: UsagePolicyView | null; error?: string } {
  const [view, setView] = useState<UsagePolicyView | null>(null)
  const [error, setError] = useState<string>()
  const settings = useStore((s) => s.settings)
  useEffect(() => {
    let live = true
    const load = (): void => {
      void api().usagePolicy().then((v) => { if (live) { setView(v); setError(undefined) } }).catch(() => {
        if (live) { setView(null); setError('Could not refresh usage. Current plan remaining is unknown; retrying automatically.') }
      })
    }
    load()
    const t = setInterval(load, REFRESH_MS)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [settings])
  return { view, error }
}

const tone = (w?: MeterWindow): string =>
  !w || w.state === 'unknown' ? 'var(--text-mute)' : (w.leftPercent ?? 0) <= 5 ? 'var(--alert)' : (w.leftPercent ?? 0) <= 30 ? 'var(--amber)' : 'var(--volt)'

const resetText = (iso?: string): string => {
  if (!iso) return ''
  const t = Date.parse(iso)
  const when = new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  return t <= Date.now() ? `reset ${when}; no newer report` : `resets ${when}`
}

function WindowLine({ w, head }: { w: MeterWindow; head?: boolean }) {
  return (
    <div className={cx('meter-window', w.state === 'unknown' && 'unknown', head && 'head')}>
      <span className="mono meter-label">{w.label}</span>
      <div className="bar" title={leftText(w)}>
        {w.state !== 'unknown' && <i style={{ width: `${w.leftPercent ?? 0}%`, ['--c' as string]: tone(w) }} />}
      </div>
      <span className="mono meter-left">{leftText(w)}</span>
      <span className="mute meter-meta">
        {[w.usedPercent !== undefined ? `${w.usedPercent}% used` : '', resetText(w.resetsAt), w.observedAt ? `last report ${ago(w.observedAt)} ago` : 'no report time'].filter(Boolean).join(' · ')}
      </span>
    </div>
  )
}

function Row({ r }: { r: MeterRow }) {
  const rest = r.windows.filter((w) => w !== r.headline)
  return (
    <div className={cx('meter-row', `lvl-${r.level}`)}>
      <div className="meter-row-head">
        <b>{r.label}</b>
        {r.planName && <span className="chip">{r.planName}</span>}
        {r.level !== 'ok' && <span className={cx('chip', r.level === 'warm' ? 'amber' : 'alert')}>{r.level === 'warm' ? '70%+ used' : r.level === 'hot' ? '85%+ used' : r.headline?.state === 'limit' ? 'limit reached' : '95%+ used'}</span>}
        <span className="mute">{r.source ?? 'no plan report yet'}</span>
      </div>
      {r.error && r.headline && <div role="status" className="mute">Could not refresh: {r.error}. Showing the last report.</div>}
      {(!r.headline || r.windows.some(w => w.state === 'unknown')) && <div role="status" className="mute">Quota unverified for unknown windows; expired reports do not hold ordinary dispatch.</div>}
      {r.headline ? <WindowLine w={r.headline} head /> : <div className="mute meter-empty">{r.error ? `could not read: ${r.error}` : (r.note ?? 'unknown')}</div>}
      {rest.map((w) => <WindowLine key={w.label} w={w} />)}
      {r.missing.length > 0 && r.headline && <div className="mute meter-missing">{r.missing.map((m) => `${m}: not reported`).join(' · ')}</div>}
    </div>
  )
}

/** Full meter: Claude and Codex rows, shared across all worlds. */
export function PlanMeter({ view, error }: { view: UsagePolicyView | null; error?: string }) {
  if (error) return <div role="status" className="mute">{error}</div>
  if (!view) return <div className="bar indeterminate"><i /></div>
  return (
    <div className="plan-meter">
      <div className="mute meter-caption">Plan remaining · shared across all projects and other apps on the same accounts · never added together</div>
      {view.meter.map((r) => <Row key={r.plan} r={r} />)}
    </div>
  )
}

// ------------------------------------------------------------- rail gauge

/** ok: under 70% used · warm: 70-84% · hot: 85% and over · unknown: no current reading */
export type GaugeTone = 'ok' | 'warm' | 'hot' | 'unknown'
const GAUGE_RANK: Record<GaugeTone, number> = { ok: 0, unknown: 1, warm: 2, hot: 3 }
const GAUGE_TEXT: Record<GaugeTone, string> = { ok: 'under 70% used', warm: '70% or more used', hot: '85% or more used', unknown: 'unknown' }

/** Fields a newer usage report may carry on the row itself; read only when the window lacks them. */
type RowExtras = Partial<{ usedPercent: number; windowLabel: string; resetsAt: string; fetchedAt: string }>

export interface GaugeLine {
  plan: string
  label: string
  tone: GaugeTone
  usedPercent?: number
  window?: string
  resetsAt?: string
  fetchedAt?: string
  source?: string
  /** why the value is unknown; set only when it is */
  error?: string
  /** a refresh failed but an earlier reading is still shown */
  warning?: string
}

/** One provider's line for the rail gauge. Missing fields degrade to "unknown" with a reason, never a bare "?". */
export function gaugeLine(r: MeterRow): GaugeLine {
  const x = r as MeterRow & RowExtras
  const h = r.headline
  const usedPercent = !h ? x.usedPercent : h.state === 'limit' ? 100 : h.state === 'known' ? h.usedPercent ?? x.usedPercent : undefined
  const known = usedPercent !== undefined
  const tone: GaugeTone = r.level === 'hot' || r.level === 'out' || h?.state === 'limit' ? 'hot' : r.level === 'warm' ? 'warm' : known ? 'ok' : 'unknown'
  const why = r.error ? `Could not read usage: ${r.error}` : r.note ? r.note : h ? `No current reading for the ${h.label} window (last report expired).` : 'No usage report yet.'
  return {
    plan: r.plan,
    label: r.label,
    tone,
    usedPercent: usedPercent === undefined ? undefined : Math.round(usedPercent),
    window: h?.label ?? x.windowLabel,
    resetsAt: h?.resetsAt ?? x.resetsAt,
    fetchedAt: h?.observedAt ?? x.fetchedAt,
    source: r.source,
    error: known ? undefined : why,
    warning: known && r.error ? `Last refresh failed: ${r.error}. Showing the previous reading.` : undefined
  }
}

/** The worst provider decides the icon colour; an unknown provider outranks "ok" so the icon never claims green without data. */
export function gaugeTone(lines: GaugeLine[]): GaugeTone {
  if (!lines.length) return 'unknown'
  return lines.reduce<GaugeTone>((worst, l) => (GAUGE_RANK[l.tone] > GAUGE_RANK[worst] ? l.tone : worst), 'ok')
}

const GAUGE_ARC = 2 * Math.PI * 8

/** A small ring gauge filled to the worst known used share. */
function GaugeGlyph({ percent }: { percent?: number }) {
  const fill = percent === undefined ? 0 : Math.min(100, Math.max(0, percent)) / 100
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
      <circle className="gauge-track" cx="11" cy="11" r="8" />
      {fill > 0 && <circle className="gauge-fill" cx="11" cy="11" r="8" strokeDasharray={`${GAUGE_ARC * fill} ${GAUGE_ARC}`} transform="rotate(-90 11 11)" />}
      <circle className="gauge-core" cx="11" cy="11" r="2.2" />
    </svg>
  )
}

function GaugeRow({ l }: { l: GaugeLine }) {
  return (
    <div className={cx('gauge-row', `tone-${l.tone}`)}>
      <div className="gauge-row-head">
        <b>{l.label}</b>
        <span className="mono gauge-pct">{l.usedPercent !== undefined ? `${l.usedPercent}% used` : 'unknown'}</span>
      </div>
      <div className="bar">{l.usedPercent !== undefined && <i style={{ width: `${l.usedPercent}%` }} />}</div>
      {l.error && <div className="gauge-error">{l.error}</div>}
      {l.warning && <div className="gauge-error">{l.warning}</div>}
      <div className="mute gauge-meta">
        {[l.window ? `${l.window} window` : '', resetText(l.resetsAt)].filter(Boolean).join(' · ') || 'window not reported'}
      </div>
      <div className="mute gauge-meta">
        {l.fetchedAt ? `fetched ${ago(l.fetchedAt)} ago` : 'fetch time unknown'} · {l.source ?? 'no report source'}
      </div>
    </div>
  )
}

/** Rail plan usage: one icon coloured by the worst plan, details in a popup on hover or keyboard focus; a click opens Usage & limits. */
export function RailMeter() {
  const { view, error } = useUsagePolicyState()
  const [open, setOpen] = useState(false)
  const gauge = useRef<HTMLDivElement>(null)
  const lines = view ? view.meter.map(gaugeLine) : []
  const tone = gaugeTone(lines)
  const worst = Math.max(-1, ...lines.map((l) => l.usedPercent ?? -1))
  const summary = error ? 'unknown' : !view ? 'loading' : lines.map((l) => `${l.label} ${l.usedPercent !== undefined ? `${l.usedPercent}% used` : 'unknown'}`).join(', ')
  return (
    <div
      ref={gauge}
      className={cx('rail-gauge', `tone-${tone}`, open && 'open')}
      tabIndex={0}
      role="button"
      aria-label={`Plan usage, ${GAUGE_TEXT[tone]}: ${summary}`}
      aria-describedby={open ? 'rail-gauge-pop' : undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onClick={() => openSettings('usage')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false)
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSettings('usage') }
      }}
    >
      <GaugeGlyph percent={worst < 0 ? undefined : worst} />
      {open && (
        <Popover anchor={gauge} placement="right-end" gap={12} id="rail-gauge-pop" className="rail-gauge-pop panel" role="tooltip">
          <div className="label rail-gauge-title">Plan usage</div>
          {error && <div className="gauge-error">{error}</div>}
          {!error && !view && <div className="mute">Reading plan usage…</div>}
          {lines.map((l) => <GaugeRow key={l.plan} l={l} />)}
          {view && (
            <div className="gauge-foot mono">
              Usage mode {USAGE_MODE_LABEL[view.mode] ?? view.mode} · unit cap {view.unitCap}
            </div>
          )}
        </Popover>
      )}
    </div>
  )
}
