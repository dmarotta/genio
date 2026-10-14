import { useEffect, useState } from 'react'
import type { PlayPoolState, PlaySlot } from '@shared/play'

export function PlayPoolPanel({ world, onChange, onError }: { world: string; onChange: () => void; onError: (error: string) => void }) {
  const [state, setState] = useState<PlayPoolState>()
  const [cap, setCap] = useState(1)
  const [bytes, setBytes] = useState<number>()
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  // Polls while collapsed too, so a stuck slot is visible without opening the section.
  useEffect(() => {
    let closed = false
    const poll = async () => { try { const s = await window.genio.api.playPool(world); if (!closed) { setState(s); if (!open) setCap(s.cap) } } catch(e) { if (!closed) onError(String(e)) } }
    void poll(); const timer = setInterval(() => void poll(), 5000)
    return () => { closed = true; clearInterval(timer) }
  }, [world, open])
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); setState(await window.genio.api.playPool(world)); onChange() } catch(e) { onError(String(e)) } finally { setBusy(false) } }
  const closeEditor = (slot: PlaySlot) => {
    const leased = slot.owner && state?.selected !== slot.id ? ` ${slot.owner} loses its lease and must lease the slot again.` : ''
    if (window.confirm(`Close the Unity editor in slot ${slot.id}? Unsaved changes in that slot copy are lost.${leased}`)) void run(() => window.genio.api.playCloseSlotEditor(world, slot.id))
  }
  const stuck = state?.slots.filter(s => s.stuck) ?? []
  return <>
    {stuck.map(s => <p key={s.id} role="alert" className="alert-text">Slot {s.id} is stuck: its Unity editor would not close ({s.stuck!.reason}{s.stuck!.pids.length ? `; PIDs ${s.stuck!.pids.join(', ')}` : ''}). Units cannot use the slot until it is closed. Use Close slot editor in Shared Unity instances, or ask Genio to recover it.</p>)}
    <details onToggle={e => setOpen(e.currentTarget.open)}><summary>Shared Unity instances · {state?.selected ? `slot ${state.selected}` : 'main copy'}{stuck.length ? ` · ${stuck.length} stuck` : ''}</summary>
    <p>Slots share a FIFO lease queue with units. Each slot uses a separate committed copy and a warm Library. Main attaches to your existing editor. Releasing a slot closes its Unity editor.</p>
    <label>Maximum slots <input aria-label="Maximum Play slots" type="number" min={1} max={8} value={cap} onChange={e => setCap(Number(e.target.value))} /></label>
    <button className="btn" disabled={busy} onClick={() => void run(() => window.genio.api.playPoolCap(world, cap))}>Save cap</button>
    <button className="btn" disabled={busy} onClick={() => void run(async () => setBytes(await window.genio.api.playPoolEstimate(world)))}>Estimate disk per slot</button>
    {bytes !== undefined && <p>About {(bytes / 1024 ** 3).toFixed(1)} GB per new slot, plus future imports. Only committed files are copied. Preparing can take several minutes.</p>}
    <button className="btn" disabled={busy || !state?.selected} onClick={() => void run(() => window.genio.api.playSelectSlot(world))}>Return to main · release lease</button>
    {state && Array.from({ length: state.cap }, (_, i) => i + 1).map(id => {
      const slot = state.slots.find(s => s.id === id)
      const label = slot?.stuck ? 'stuck' : slot?.closing ? 'closing editor' : slot?.preparing ? 'preparing' : slot?.owner ?? 'available'
      return <div key={id}>Slot {id} · {label}{slot?.editor && !slot.closing ? ' · editor open' : ''} {slot?.revision?.slice(0, 8)}
        <button className="btn" disabled={busy || slot?.preparing || slot?.closing || !!slot?.stuck || !slot?.revision && bytes === undefined} onClick={() => void run(() => window.genio.api.playSelectSlot(world, id))}>Use slot {id}</button>
        {slot?.owner && state.selected !== id && <button className="btn" disabled={busy || slot.preparing || slot.closing} onClick={() => void run(() => window.genio.api.playSelectSlot(world, id, true))}>Take over slot {id}</button>}
        {slot && (slot.editor || slot.stuck) && <button className="btn alert" disabled={busy || slot.preparing || slot.closing} onClick={() => closeEditor(slot)}>Close slot editor</button>}
      </div>
    })}
    {!!state?.queue.length && <p>Queue: {state.queue.join(', ')}. Retry Use slot within 30 seconds to keep your place.</p>}
    </details>
  </>
}
