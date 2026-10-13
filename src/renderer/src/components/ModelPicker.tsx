import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Brain, Code2, Network, Orbit, Sparkles } from 'lucide-react'
import { canDrive, filterModels, type ModelCatalogue, type CatalogueRoute } from '@shared/model-catalogue'
import type { UsageReport } from '@shared/api'
import { api, errText } from '../store'
import { ago } from '../lib/format'

let latest: ModelCatalogue = { routes: [] }
let pending: Promise<ModelCatalogue> | undefined
async function fetchCatalogue(refresh = false): Promise<ModelCatalogue> {
  pending ??= api().modelCatalogue(refresh).then(result => {
    latest = result
    window.dispatchEvent(new Event('genio-model-catalogue'))
    return result
  }).finally(() => { pending = undefined })
  return pending
}
export function useModelCatalogue(): ModelCatalogue {
  const [value, setValue] = useState(latest)
  useEffect(() => {
    const update = (): void => setValue(latest)
    const refresh = (): void => { void fetchCatalogue().catch(() => {}) }
    window.addEventListener('genio-model-catalogue', update)
    window.addEventListener('focus', refresh)
    const timer = setInterval(refresh, 60_000)
    refresh()
    return () => { clearInterval(timer); window.removeEventListener('genio-model-catalogue', update); window.removeEventListener('focus', refresh) }
  }, [])
  return value
}
export type ModelSelectProps = { value: string; onChange: (value: string) => void; title?: string; disabled?: boolean; style?: CSSProperties }
const STATES = { connected: 'Connected', 'free-no-login': 'Free · no login', 'sign-in-needed': 'Sign in', unavailable: 'Unavailable here' }
const PROVIDER_ICONS: Record<string, typeof Brain> = { Anthropic: Sparkles, OpenAI: Brain, Google: Orbit, OpenCode: Code2, OpenRouter: Network }
function usageText(route: CatalogueRoute, usage?: UsageReport): string {
  const limits = usage?.tools.find(t => t.tool === route.runtime)?.limits || []
  if (!limits.length) return 'Usage unknown'
  return limits.map(l => `${l.name || l.plan || l.source}: ${l.windows.map(w =>
    `${w.label} ${w.usedPercent === undefined ? w.status || 'unknown' : `${w.usedPercent}% used`}${w.stale ? ' (stale)' : ''}${w.resetsAt ? `; resets ${new Date(w.resetsAt).toLocaleString()}` : ''}`).join(', ')} · reported ${ago(l.updatedAt)}`).join(' · ')
}
export function ModelPicker({ value, onChange, onAccounts, ...props }: ModelSelectProps & { onAccounts: () => void }) {
  const catalogue = useModelCatalogue()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [provider, setProvider] = useState('')
  const [internal, setInternal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [usage, setUsage] = useState<UsageReport>()
  const panel = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const selected = catalogue.routes.flatMap(r => r.models).find(m => m.runtime === 'claude' && (m.id === value || m.aliases.includes(value || 'default')))
  const refresh = async (force = false): Promise<void> => {
    setBusy(true); setError('')
    try { await fetchCatalogue(force) } catch (e) { setError(errText(e)) } finally { setBusy(false) }
    void api().accountUsage().then(setUsage).catch(() => {})
  }
  useEffect(() => {
    if (!open) return
    void refresh()
    panel.current?.querySelector('input')?.focus()
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() }
      if (event.key === 'Tab') {
        const nodes = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input')
        if (!nodes?.length) return
        const first = nodes[0], last = nodes[nodes.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [open])
  const choose = (id: string): void => {
    if (id !== value) onChange(id)
    setOpen(false); trigger.current?.focus()
  }
  const anchor = trigger.current?.getBoundingClientRect()
  const below = !!anchor && window.innerHeight - anchor.bottom > anchor.top
  const position: CSSProperties = anchor ? { position: 'fixed', left: Math.max(12, Math.min(anchor.left, window.innerWidth - 552)),
    ...(below ? { top: anchor.bottom + 8 } : { bottom: window.innerHeight - anchor.top + 8 }),
    maxHeight: Math.max(160, (below ? window.innerHeight - anchor.bottom : anchor.top) - 24) } : {}
  const visible = catalogue.routes.map(r => ({ ...r, stale: r.stale || !!r.sourceAt && Date.now() - Date.parse(r.sourceAt) >= 5 * 60_000 })).filter(r => !provider || r.provider === provider)
  return <>
    <button ref={trigger} className="select" {...props} aria-haspopup="dialog" aria-expanded={open}
      style={{ ...props.style, maxWidth: 'min(100%, 240px)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      onClick={() => { setOpen(true); void api().featureUsed('model-picker') }}>{selected?.name || value || 'Default model'} ▾</button>
    {open && createPortal(<div style={{ position: 'fixed', inset: 0, zIndex: 10000, background: '#0003' }}
      onMouseDown={event => { if (event.target === event.currentTarget) { setOpen(false); trigger.current?.focus() } }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label="Choose a model" style={{ background: 'var(--bg, #111820)', border: '1px solid var(--line, #405060)', borderRadius: 10, padding: 16, width: 540, maxWidth: 'calc(100vw - 24px)', maxHeight: '80vh', overflow: 'auto', boxShadow: '0 12px 60px #0009', ...position }}>
        <div style={{ display: 'flex', gap: 8 }}><input className="input" style={{ minWidth: 0 }} aria-label="Search models" placeholder="Search models, providers or runtimes" value={search} onChange={e => setSearch(e.target.value)} />
          <button className="btn sm" onClick={() => { setOpen(false); trigger.current?.focus() }}>Close</button></div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '12px 0' }}>
          {['', ...new Set(catalogue.routes.map(r => r.provider))].map(p => <button key={p} className={`chip ${provider === p ? 'neon' : ''}`} aria-pressed={provider === p} onClick={() => setProvider(p)}>{p || 'All providers'}</button>)}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 12 }}>
          <button className="btn sm" disabled={busy} onClick={() => void refresh(true)}>{busy ? 'Refreshing…' : 'Refresh'}</button>
          <button className="btn sm" onClick={() => { setOpen(false); onAccounts() }}>Accounts</button>
          <label><input type="checkbox" checked={internal} onChange={e => setInternal(e.target.checked)} /> Show internal</label>
        </div>
        {error && <p role="alert">{error}</p>}
        <p className="mute">Drive this chat · Changes apply between turns; effort resets to auto on model change. Other runtimes: chat driver coming / Ask another model coming.</p>
        {!search && (!provider || provider === 'Anthropic') && <button className="btn sm" disabled={!catalogue.routes.some(canDrive)} onClick={() => choose('')}>Reset to inherited / default model</button>}
        {visible.map(route => {
          const models = filterModels(route.models, search, provider, internal)
          const Icon = PROVIDER_ICONS[route.provider] || Brain
          return <div key={`${route.runtime}:${route.provider}`}>
            {!models.length && (!search || route.provider.toLowerCase().includes(search.toLowerCase())) && <p>{route.provider} · {STATES[route.state]} · {route.reason || 'No matching models'} · {usageText(route, usage)}</p>}
            {models.map(model => <button key={model.key} className="btn" disabled={!canDrive(route)} onClick={() => choose(model.id)}
              style={{ display: 'block', width: '100%', textAlign: 'left', whiteSpace: 'normal', height: 'auto', opacity: 1, padding: 10, margin: '6px 0' }}>
              <strong><Icon size={14} aria-hidden="true" /> {model.name}{selected?.key === model.key ? ' ✓' : ''}</strong>
              <div>{model.id} · {route.accountLabel || route.provider} · {route.runtime === 'codex' ? 'Codex' : route.runtime}</div>
              <div>{STATES[route.state]}{route.reason ? ` · ${route.reason}` : ''}{route.stale ? ' · Stale catalogue' : ''}{route.sourceAt ? ` · discovered ${ago(route.sourceAt)}` : ''}</div>
              {route.runtime !== 'claude' && <div>Chat driver coming · Ask another model coming</div>}
              <div className="mute">{usageText(route, usage)}{model.images === undefined ? '' : model.images ? ' · Images supported' : ' · Text only'}</div>
            </button>)}
          </div>
        })}
        {!catalogue.routes.length && <p>{busy ? 'Discovering connected models…' : 'Catalogue unavailable. Try Refresh.'}</p>}
      </div>
    </div>, document.body)}
  </>
}
