/**
 * The shared plan meter: one row per plan (Claude, Codex), never summed. Each
 * reported window shows what is left, its reset time, source and observation
 * age; an expired or missing observation reads "unknown", never "100% left".
 * Used full-size in Systems (Accounts, Usage) and compact in the rail.
 */
import { useEffect, useState } from 'react'
import { leftText, type MeterRow, type MeterWindow, type UsagePolicyView } from '@shared/usage-mode'
import { api, go, useStore } from '../store'
import { requestSystemsSection } from '../views/Systems'
import { ago, cx } from '../lib/format'

const REFRESH_MS = 60_000

/** The cached policy view: on mount, every minute and when settings change. Main reads local evidence only. */
export function useUsagePolicy(): UsagePolicyView | null {
  const [view, setView] = useState<UsagePolicyView | null>(null)
  const settings = useStore((s) => s.settings)
  useEffect(() => {
    let live = true
    const load = (): void => {
      void api().usagePolicy().then((v) => live && setView(v)).catch(() => undefined)
    }
    load()
    const t = setInterval(load, REFRESH_MS)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [settings])
  return view
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
        {[resetText(w.resetsAt), w.observedAt ? `last report ${ago(w.observedAt)} ago` : 'no report time'].filter(Boolean).join(' · ')}
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
        {r.level !== 'ok' && <span className={cx('chip', r.level === 'warm' ? 'amber' : 'alert')}>{r.level === 'warm' ? '70%+ used' : r.level === 'hot' ? '85%+ used' : 'limit'}</span>}
        <span className="mute">{r.source ?? 'no plan report yet'}</span>
      </div>
      {r.headline ? <WindowLine w={r.headline} head /> : <div className="mute meter-empty">{r.error ? `could not read: ${r.error}` : (r.note ?? 'unknown')}</div>}
      {rest.map((w) => <WindowLine key={w.label} w={w} />)}
      {r.missing.length > 0 && r.headline && <div className="mute meter-missing">{r.missing.map((m) => `${m}: not reported`).join(' · ')}</div>}
    </div>
  )
}

/** Full meter: Claude and Codex rows, shared across all worlds. */
export function PlanMeter({ view }: { view: UsagePolicyView | null }) {
  if (!view) return <div className="bar indeterminate"><i /></div>
  return (
    <div className="plan-meter">
      <div className="mute meter-caption">Plan remaining · shared across all worlds and other apps on the same accounts · never added together</div>
      {view.meter.map((r) => <Row key={r.plan} r={r} />)}
    </div>
  )
}

/** Compact rail version: one bar per plan; click opens Systems → Usage. */
export function RailMeter() {
  const view = useUsagePolicy()
  if (!view) return null
  const title = view.meter
    .map((r) => `${r.label}: ${leftText(r.headline)}${r.headline ? ` (${r.headline.label})` : ''}`)
    .join('\n')
  return (
    <button className="rail-meter" title={`${title}\nClick for Usage`} aria-label="Plan remaining" onClick={() => {
      requestSystemsSection('usage')
      go('systems')
    }}>
      {view.meter.map((r) => (
        <div key={r.plan} className={cx('rail-meter-row', `lvl-${r.level}`)}>
          <span className="rail-meter-name">{r.label.slice(0, 2).toUpperCase()}</span>
          <span className="rail-meter-val mono">{!r.headline || r.headline.state === 'unknown' ? '?' : `${r.headline.leftPercent}`}</span>
          <div className="bar">{r.headline && r.headline.state !== 'unknown' && <i style={{ width: `${r.headline.leftPercent ?? 0}%`, ['--c' as string]: tone(r.headline) }} />}</div>
        </div>
      ))}
    </button>
  )
}
