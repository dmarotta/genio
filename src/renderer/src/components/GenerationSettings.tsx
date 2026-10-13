import { useEffect, useState } from 'react'
import type { FalOutputKind, FalWorldState } from '@shared/api'
import type { UthanaWorldState } from '@shared/uthana'
import { suggestFolder } from '@shared/fal'
import { api, errText, toast } from '../store'
import { Field, Toggle } from './ui'

const KINDS: [FalOutputKind, string][] = [['image', 'Images'], ['audio', 'Audio'], ['video', 'Video'], ['model', '3D models'], ['other', 'Other assets']]
const amount = (s: string): number | undefined => s.trim() ? Number(s) : undefined
const invalid = (s: string): boolean => !!s.trim() && (!Number.isFinite(Number(s)) || Number(s) < 0)

export function GenerationSettings({ world }: { world: string }) {
  const [state, setState] = useState<{ fal: FalWorldState; uthana: UthanaWorldState }>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [busy, setBusy] = useState(false)
  const [cap, setCap] = useState('')
  const [threshold, setThreshold] = useState('')
  const [folders, setFolders] = useState<Partial<Record<FalOutputKind, string>>>({})
  const [animation, setAnimation] = useState('')
  const [codex, setCodex] = useState(true)
  useEffect(() => {
    let live = true
    setState(undefined)
    setError('')
    void Promise.all([api().falWorld(world), api().uthanaWorld(world)]).then(([fal, uthana]) => {
      if (!live) return
      setState({ fal, uthana })
      setCap(fal.config.budget?.monthly_usd?.toString() ?? '')
      setThreshold(fal.config.budget?.confirm_over_usd?.toString() ?? '')
      setFolders(fal.config.folders ?? {})
      setAnimation(uthana.config.folder ?? '')
      const provider = fal.config.providers?.codex
      setCodex(provider !== false && !(provider && typeof provider === 'object' && 'enabled' in provider && provider.enabled === false))
    }).catch((e) => { if (live) setError(errText(e)) })
    return () => { live = false }
  }, [world, retry])

  const save = async (): Promise<void> => {
    if (!state || invalid(cap) || invalid(threshold)) return
    setBusy(true)
    setError('')
    let falSaved = false
    try {
      const cfg = state.fal.config
      const provider = cfg.providers?.codex
      const fal = await api().falWorldConfig(world, {
        ...cfg, folders,
        budget: { ...cfg.budget, monthly_usd: amount(cap), confirm_over_usd: amount(threshold) },
        providers: { ...cfg.providers, codex: { ...(provider && typeof provider === 'object' ? provider : {}), enabled: codex } }
      })
      falSaved = true
      setState((s) => s && { ...s, fal })
      const uthana = await api().uthanaWorldConfig(world, { ...state.uthana.config, folder: animation })
      setState({ fal, uthana })
      toast('success', 'Generation settings saved', `${world}: saved in the world, not committed`)
    } catch (e) {
      setError(`${falSaved ? 'Budget, asset folders and Codex settings saved; animation folder could not be saved. ' : ''}${errText(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return <section className="world-generation" aria-label="Generation settings">
    <h4>Generation</h4>
    <p className="mute">Generate assets with Genio in Inventory chat. These settings apply to this world.</p>
    {error && <p role="alert" className="alert-text">{error}</p>}
    {!state ? error ? <button className="btn sm" onClick={() => setRetry((n) => n + 1)}>Retry settings</button> : <p className="mute">Loading generation settings…</p> : <>
      <fieldset className="generation-fields form-grid" disabled={busy}>
        <Field label="Monthly budget (USD)" hint="Shared paid-generation cap. Runs above it stop. Blank means no cap.">
          <input className="input" aria-label="Monthly budget (USD)" inputMode="decimal" value={cap} placeholder="No cap" aria-invalid={invalid(cap)} onChange={(e) => setCap(e.target.value)} />
        </Field>
        <Field label="Confirm runs over (USD)" hint="Ask before a paid run above this amount. Blank uses $0.25; 0 asks for every paid run.">
          <input className="input" aria-label="Confirm runs over (USD)" inputMode="decimal" value={threshold} placeholder="0.25" aria-invalid={invalid(threshold)} onChange={(e) => setThreshold(e.target.value)} />
        </Field>
        <Field label="Codex images" hint="Use the ChatGPT plan for images. Enabled by default; no paid-run confirmation." wide>
          <Toggle checked={codex} onChange={setCodex} label="Enable Codex images in this world" />
        </Field>
        {KINDS.map(([kind, label]) => <Field key={kind} label={`${label} folder`} hint="Relative to the world root. Blank uses the engine default.">
          <input className="input mono" aria-label={`${label} folder`} value={folders[kind] ?? ''} placeholder={suggestFolder(state.fal.engine, kind, state.fal.engineRoot)} onChange={(e) => setFolders((f) => ({ ...f, [kind]: e.target.value }))} />
        </Field>)}
        <Field label="Animations folder" hint="Relative to the world root. Blank uses the engine default.">
          <input className="input mono" aria-label="Animations folder" value={animation} placeholder={state.uthana.folder} onChange={(e) => setAnimation(e.target.value)} />
        </Field>
      </fieldset>
      {(invalid(cap) || invalid(threshold)) && <p role="alert">Enter a non-negative amount, or leave it blank.</p>}
      <button className="btn sm solid" disabled={busy || invalid(cap) || invalid(threshold)} onClick={() => void save()}>{busy ? 'Saving…' : 'Save generation settings'}</button>
    </>}
  </section>
}
