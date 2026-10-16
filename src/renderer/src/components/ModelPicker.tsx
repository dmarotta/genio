import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { canDrive, rankedModels, modelRowLabel, modelDisabledReason, staticClaudeCatalogue, type ModelCatalogue } from '@shared/model-catalogue'
import { api } from '../store'
import './ModelPicker.css'
import { useChatDocument } from './ChatDocument'
import { layerRoot } from './Layer'

let latest: ModelCatalogue = staticClaudeCatalogue()
let pending: Promise<ModelCatalogue> | undefined
let queuedRefresh: Promise<ModelCatalogue> | undefined
async function fetchCatalogue(force = false): Promise<ModelCatalogue> {
  if (force && pending) {
    queuedRefresh ??= pending.then(() => fetchCatalogue(true)).finally(() => { queuedRefresh = undefined })
    return queuedRefresh
  }
  pending ??= Promise.resolve().then(() => api().modelCatalogue(force)).then(result => {
    if (result.routes.some(route => route.models.length)) latest = result
    return latest
  }).catch(() => latest).then(result => {
    window.dispatchEvent(new Event('genio-model-catalogue'))
    return result
  }).finally(() => { pending = undefined })
  return pending
}
export function useModelCatalogue(): ModelCatalogue {
  const [value, setValue] = useState(latest)
  useEffect(() => {
    const update = (): void => setValue(latest)
    const refresh = (): void => { void fetchCatalogue() }
    window.addEventListener('genio-model-catalogue', update)
    window.addEventListener('focus', refresh)
    const unsubscribe = window.genio?.on(event => {
      if (event.type === 'model-catalogue-invalidated') void fetchCatalogue(true)
    })
    const timer = setInterval(refresh, 60_000)
    refresh()
    return () => { clearInterval(timer); unsubscribe?.(); window.removeEventListener('genio-model-catalogue', update); window.removeEventListener('focus', refresh) }
  }, [])
  return value
}
export type ModelSelectProps = { value: string; onChange: (value: string) => void; title?: string; disabled?: boolean; style?: CSSProperties }
export function ModelPicker({ value, onChange, onAccounts: _onAccounts, ...props }: ModelSelectProps & { onAccounts: () => void }) {
  const document = useChatDocument()
  const window = document.defaultView!
  const catalogue = useModelCatalogue()
  const [open, setOpen] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const selected = value ? catalogue.routes.flatMap(r => r.models).find(m => m.key === value || m.runtime === 'claude' && (m.id === value || m.aliases.includes(value))) : undefined
  const close = (): void => { setOpen(false); trigger.current?.focus() }
  useEffect(() => {
    if (!open) return
    void fetchCatalogue()
    const nodes = (): HTMLButtonElement[] => [...(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])]
    ;(panel.current?.querySelector<HTMLButtonElement>('button[aria-selected="true"]:not(:disabled)') || nodes()[0])?.focus()
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key === 'Enter' && panel.current?.contains(document.activeElement)) {
        event.preventDefault(); (document.activeElement as HTMLButtonElement).click()
      }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(event.key)) {
        const rows = nodes()
        if (!rows.length) return
        event.preventDefault()
        const index = rows.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 :
          (index + (event.key === 'ArrowUp' || event.key === 'Tab' && event.shiftKey ? -1 : 1) + rows.length) % rows.length
        rows[next].focus()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [open, document])
  const choose = (id: string): void => { if (id !== value) onChange(id); close() }
  const anchor = trigger.current?.getBoundingClientRect()
  const below = !!anchor && window.innerHeight - anchor.bottom > anchor.top
  const position: CSSProperties = anchor ? { left: Math.max(12, Math.min(anchor.left, window.innerWidth - 332)),
    ...(below ? { top: anchor.bottom + 6 } : { bottom: window.innerHeight - anchor.top + 6 }),
    maxHeight: Math.max(100, (below ? window.innerHeight - anchor.bottom : anchor.top) - 24) } : {}
  const groups = [...new Set(catalogue.routes.map(r => r.provider))].sort().map(provider => ({ provider,
    rows: catalogue.routes.filter(r => r.provider === provider).flatMap(route => rankedModels(route.models).map(model => ({ route, model })))
  })).filter(group => group.rows.length)
  return <>
    <button ref={trigger} className="select" {...props} aria-haspopup="listbox" aria-expanded={open}
      style={{ ...props.style, maxWidth: 'min(100%, 240px)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      onClick={() => { setOpen(true); void api().featureUsed('model-picker').catch(() => {}) }}>{selected ? modelRowLabel(selected) : value || 'Default model'} &#9662;</button>
    {open && createPortal(<div className="model-picker-backdrop"
      onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
      <div ref={panel} role="listbox" aria-label="Choose a model" className="model-picker-list" style={position}>
        <button role="option" aria-selected={!value} className="model-picker-row" onClick={() => choose('')}><span>Default</span>{!value && <span aria-hidden="true">&#10003;</span>}</button>
        {groups.map(({ provider, rows }) => <div key={provider} role="group" aria-label={provider}>
          <div className="model-picker-provider" aria-hidden="true">{provider}</div>
          {rows.map(({ route, model }) => <button key={model.key} role="option" aria-selected={selected?.key === model.key}
            className="model-picker-row" title={model.id} disabled={!canDrive(route)} onClick={() => { if (canDrive(route)) choose(route.runtime === 'claude' ? model.id : model.key) }}>
            <span>{modelRowLabel(model)}</span><span className="model-picker-reason">{modelDisabledReason(route)}{selected?.key === model.key && <span aria-hidden="true"> &#10003;</span>}</span>
          </button>)}
        </div>)}
      </div>
    </div>, layerRoot(document))}
  </>
}
