import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { FalOutputKind, FalWorldState } from '@shared/api'
import type { UthanaWorldState } from '@shared/uthana'
import { suggestFolder } from '@shared/fal'
import { api, errText } from '../store'
import { Field, Toggle } from './ui'

/** Deep-link target: Settings › This project › Asset generation scrolls here and focuses it. */
export const GENERATION_ANCHOR = 'generation-settings'

const KINDS:[FalOutputKind, string][] = [['image', 'Images'], ['audio', 'Audio'], ['video', 'Video'], ['model', '3D models'], ['other', 'Other assets']]
const amount = (s: string): number | undefined => s.trim() ? Number(s) : undefined
const invalid = (s: string): boolean => !!s.trim() && (!Number.isFinite(Number(s)) || Number(s) < 0)

interface FalDraft { cap: string; threshold: string; folders: Partial<Record<FalOutputKind, string>>; codex: boolean }

/** Saves like the rest of Settings: a field commits on blur or Enter, the toggle at once. */
export function GenerationSettings({ world }: { world: string }) {
  const [state, setState] = useState<{ fal: FalWorldState; uthana: UthanaWorldState }>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [cap, setCap] = useState('')
  const [threshold, setThreshold] = useState('')
  const [folders, setFolders] = useState<Partial<Record<FalOutputKind, string>>>({})
  const [animation, setAnimation] = useState('')
  const [codex, setCodex] = useState(true)
  // Saves run one after another against the last saved config, so a blur and a toggle never race.
  const saved = useRef<{ fal: FalWorldState; uthana: UthanaWorldState } | undefined>(undefined)
  const queue = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    let live = true
    setState(undefined)
    saved.current = undefined
    setError('')
    void Promise.all([api().falWorld(world), api().uthanaWorld(world)]).then(([fal, uthana]) => {
      if (!live) return
      setState({ fal, uthana })
      saved.current = { fal, uthana }
      setCap(fal.config.budget?.monthly_usd?.toString() ?? '')
      setThreshold(fal.config.budget?.confirm_over_usd?.toString() ?? '')
      setFolders(fal.config.folders ?? {})
      setAnimation(uthana.config.folder ?? '')
      const provider = fal.config.providers?.codex
      setCodex(provider !== false && !(provider && typeof provider === 'object' && 'enabled' in provider && provider.enabled === false))
    }).catch((e) => { if (live) setError(errText(e)) })
    return () => { live = false }
  }, [world, retry])

  const enqueue = (fn: () => Promise<void>): void => { queue.current = queue.current.then(fn) }
  const saveFal = (draft: FalDraft): void => {
    if (invalid(draft.cap) || invalid(draft.threshold)) return
    enqueue(async () => {
      const current = saved.current
      if (!current) return
      const cfg = current.fal.config
      const provider = cfg.providers?.codex
      const next = {
        ...cfg, folders: draft.folders,
        budget: { ...cfg.budget, monthly_usd: amount(draft.cap), confirm_over_usd: amount(draft.threshold) },
        providers: { ...cfg.providers, codex: { ...(provider && typeof provider === 'object' ? provider : {}), enabled: draft.codex } }
      }
      if (JSON.stringify(next) === JSON.stringify(cfg)) return
      try {
        const fal = await api().falWorldConfig(world, next)
        saved.current = { ...current, fal }
        setState((s) => s && { ...s, fal })
        setError('')
      } catch (e) {
        setError(`Budget, asset folders and Codex images could not be saved. ${errText(e)}`)
      }
    })
  }
  const saveAnimation = (folder: string): void => enqueue(async () => {
    const current = saved.current
    if (!current || (current.uthana.config.folder ?? '') === folder) return
    try {
      const uthana = await api().uthanaWorldConfig(world, { ...current.uthana.config, folder })
      saved.current = { ...current, uthana }
      setState((s) => s && { ...s, uthana })
      setError('')
    } catch (e) {
      setError(`The animation folder could not be saved. ${errText(e)}`)
    }
  })
  const draft: FalDraft = { cap, threshold, folders, codex }
  const commit = { onBlur: () => saveFal(draft), onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter') saveFal(draft) } }

  return <section id={GENERATION_ANCHOR} tabIndex={-1} className="world-generation" aria-label="Generation settings">
    <p className="mute">Generate assets with Genio in Inventory chat. Saved in this project, not committed.</p>
    {error && <p role="alert" className="alert-text">{error}</p>}
    {!state ? error ? <button className="btn sm" onClick={() => setRetry((n) => n + 1)}>Retry settings</button> : <p className="mute">Loading generation settings…</p> : <>
      <div className="generation-fields form-grid">
        <Field label="Monthly budget (USD)" hint="Shared paid-generation cap. Runs above it stop. Blank means no cap.">
          <input className="input" aria-label="Monthly budget (USD)" inputMode="decimal" value={cap} placeholder="No cap" aria-invalid={invalid(cap)} onChange={(e) => setCap(e.target.value)} {...commit} />
        </Field>
        <Field label="Ask before runs over (USD)" hint="Ask before a paid run above this amount. Blank uses $0.25; 0 asks for every paid run.">
          <input className="input" aria-label="Ask before runs over (USD)" inputMode="decimal" value={threshold} placeholder="0.25" aria-invalid={invalid(threshold)} onChange={(e) => setThreshold(e.target.value)} {...commit} />
        </Field>
        <Field label="Codex images" hint="Use the ChatGPT plan for images. Enabled by default; no paid-run confirmation." wide>
          <Toggle checked={codex} onChange={(v) => { setCodex(v); saveFal({ ...draft, codex: v }) }} label="Enable Codex images in this project" />
        </Field>
      </div>
      {(invalid(cap) || invalid(threshold)) && <p role="alert">Enter a non-negative amount, or leave it blank.</p>}
      <details className="generation-folders">
        <summary className="label">Asset folders</summary>
        <div className="generation-fields form-grid">
          {KINDS.map(([kind, label]) => <Field key={kind} label={`${label} folder`} hint="Relative to the project root. Blank uses the engine default.">
            <input className="input mono" aria-label={`${label} folder`} value={folders[kind] ?? ''} placeholder={suggestFolder(state.fal.engine, kind, state.fal.engineRoot)} onChange={(e) => setFolders((f) => ({ ...f, [kind]: e.target.value }))} {...commit} />
          </Field>)}
          <Field label="Animations folder" hint="Relative to the project root. Blank uses the engine default.">
            <input className="input mono" aria-label="Animations folder" value={animation} placeholder={state.uthana.folder} onChange={(e) => setAnimation(e.target.value)} onBlur={() => saveAnimation(animation)} onKeyDown={(e) => { if (e.key === 'Enter') saveAnimation(animation) }} />
          </Field>
        </div>
      </details>
    </>}
  </section>
}
