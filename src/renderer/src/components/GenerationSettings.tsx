import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { FalWorldState } from '@shared/api'
import { api, errText } from '../store'
import { Field, Toggle } from './ui'

/** Deep-link target: Settings › This project › Asset generation scrolls here and focuses it. */
export const GENERATION_ANCHOR = 'generation-settings'

const amount = (s: string): number | undefined => s.trim() ? Number(s) : undefined
const invalid = (s: string): boolean => !!s.trim() && (!Number.isFinite(Number(s)) || Number(s) < 0)

interface FalDraft { cap: string; codex: boolean }

/**
 * The project's paid-generation budget and its Codex images switch. Saves like the rest of Settings:
 * the budget commits on blur or Enter, the toggle at once. Asset folders stay in the project's config
 * (set by asking Genio); this page never rewrites them.
 */
export function GenerationSettings({ world }: { world: string }) {
  const [state, setState] = useState<FalWorldState>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [cap, setCap] = useState('')
  const [codex, setCodex] = useState(true)
  // Saves run one after another against the last saved config, so a blur and a toggle never race.
  const saved = useRef<FalWorldState | undefined>(undefined)
  const queue = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    let live = true
    setState(undefined)
    saved.current = undefined
    setError('')
    void api().falWorld(world).then((fal) => {
      if (!live) return
      setState(fal)
      saved.current = fal
      setCap(fal.config.budget?.monthly_usd?.toString() ?? '')
      const provider = fal.config.providers?.codex
      setCodex(provider !== false && !(provider && typeof provider === 'object' && 'enabled' in provider && provider.enabled === false))
    }).catch((e) => { if (live) setError(errText(e)) })
    return () => { live = false }
  }, [world, retry])

  const saveFal = (draft: FalDraft): void => {
    if (invalid(draft.cap)) return
    queue.current = queue.current.then(async () => {
      const current = saved.current
      if (!current) return
      const cfg = current.config
      const provider = cfg.providers?.codex
      const next = {
        ...cfg,
        budget: { ...cfg.budget, monthly_usd: amount(draft.cap) },
        providers: { ...cfg.providers, codex: { ...(provider && typeof provider === 'object' ? provider : {}), enabled: draft.codex } }
      }
      if (JSON.stringify(next) === JSON.stringify(cfg)) return
      try {
        const fal = await api().falWorldConfig(world, next)
        saved.current = fal
        setState(fal)
        setError('')
      } catch (e) {
        setError(`Budget and Codex images could not be saved. ${errText(e)}`)
      }
    })
  }
  const draft: FalDraft = { cap, codex }
  const commit = { onBlur: () => saveFal(draft), onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter') saveFal(draft) } }

  return <section id={GENERATION_ANCHOR} tabIndex={-1} className="world-generation" aria-label="Generation settings">
    {error && <p role="alert" className="alert-text">{error}</p>}
    {!state ? error ? <button className="btn sm" onClick={() => setRetry((n) => n + 1)}>Retry settings</button> : <p className="mute">Loading generation settings…</p> : <>
      <div className="generation-fields form-grid">
        <Field label="Monthly budget (USD)">
          <input className="input" aria-label="Monthly budget (USD)" inputMode="decimal" value={cap} placeholder="No cap" aria-invalid={invalid(cap)} onChange={(e) => setCap(e.target.value)} {...commit} />
        </Field>
        <Field label="Codex images" wide>
          <Toggle checked={codex} onChange={(v) => { setCodex(v); saveFal({ ...draft, codex: v }) }} />
        </Field>
      </div>
      {invalid(cap) && <p role="alert">Enter a non-negative amount, or leave it blank.</p>}
    </>}
  </section>
}
