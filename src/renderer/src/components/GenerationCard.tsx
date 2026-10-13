import { useState } from 'react'
import type { GenerationCard as Card } from '@shared/generation'
import { api, errText } from '../store'

/** The only generation control in chat: approve an exact, already priced request. */
export function GenerationCard({ card, wksp }: { card: Card; wksp: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const approve = async () => {
    setBusy(true); setError('')
    try { await api().approveGeneration(wksp, card.id) } catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }
  return <div className="generation-card" aria-live="polite">
    <strong>{card.status === 'awaiting_approval' ? 'Approve generation' : card.status === 'completed' ? 'Asset ready' : card.status === 'failed' ? 'Generation failed' : card.status === 'placing' ? 'Saving asset…' : 'Generating…'}</strong>
    <div>{card.model}{card.world ? ` · ${card.world}` : ''}</div>
    {card.progress && card.status === 'running' && <div className="mute">{card.progress}</div>}
    <div className="mute">{card.provider === 'codex' ? 'ChatGPT plan · no API charge' : `Estimated $${card.estimatedUsd.toFixed(3)} · month $${card.spentUsd.toFixed(3)}${card.capUsd !== undefined ? ` / $${card.capUsd.toFixed(2)}` : ''}`}</div>
    {card.status === 'awaiting_approval' && <button className="btn primary" disabled={busy} onClick={() => void approve()}>{busy ? 'Starting…' : `Approve $${card.estimatedUsd.toFixed(3)}`}</button>}
    {card.paths.map(p => <div className="mono selectable" key={p}>{p}</div>)}
    {card.outputs?.filter(o => o.url).map(o => <div key={o.name}>
      {o.kind === 'audio' ? <audio controls preload="none" src={o.url} /> : o.kind === 'video' ? <video controls preload="metadata" src={o.url} /> : o.kind === 'image' ? <img src={o.url} alt={o.name} /> : <span className="mute">{o.name}</span>}
    </div>)}
    {card.paths.length > 0 && <div className="mute">Saved in the world, uncommitted.</div>}
    {card.warnings.map((w, i) => <div className="mute" key={i}>{w}</div>)}
    {(card.error || error) && <div role="alert" className="alert-text">{card.error || error}</div>}
  </div>
}
