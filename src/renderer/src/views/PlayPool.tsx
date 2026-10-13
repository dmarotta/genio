import { useEffect, useState } from 'react'
import type { PlayPoolState } from '@shared/play'

export function PlayPoolPanel({ world, onChange, onError }: { world: string; onChange: () => void; onError: (error: string) => void }) {
  const [state, setState] = useState<PlayPoolState>()
  const [cap, setCap] = useState(1)
  const [bytes, setBytes] = useState<number>()
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    let closed = false
    const poll = async () => { try { const s = await window.genio.api.playPool(world); if (!closed) { setState(s); setCap(s.cap) } } catch(e) { if (!closed) onError(String(e)) } }
    void poll(); const timer = setInterval(() => void poll(), 5000)
    return () => { closed = true; clearInterval(timer) }
  }, [world, open])
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); setState(await window.genio.api.playPool(world)); onChange() } catch(e) { onError(String(e)) } finally { setBusy(false) } }
  return <details onToggle={e => setOpen(e.currentTarget.open)}><summary>Shared Unity instances · {state?.selected ? `slot ${state.selected}` : 'main copy'}</summary>
    <p>Slots share a FIFO lease queue with units. Each slot uses a separate committed copy and a warm Library. Main attaches to your existing editor.</p>
    <label>Maximum slots <input aria-label="Maximum Play slots" type="number" min={1} max={8} value={cap} onChange={e => setCap(Number(e.target.value))} /></label>
    <button className="btn" disabled={busy} onClick={() => void run(() => window.genio.api.playPoolCap(world, cap))}>Save cap</button>
    <button className="btn" disabled={busy} onClick={() => void run(async () => setBytes(await window.genio.api.playPoolEstimate(world)))}>Estimate disk per slot</button>
    {bytes !== undefined && <p>About {(bytes / 1024 ** 3).toFixed(1)} GB per new slot, plus future imports. Only committed files are copied. Preparing can take several minutes.</p>}
    <button className="btn" disabled={busy || !state?.selected} onClick={() => void run(() => window.genio.api.playSelectSlot(world))}>Return to main · release lease</button>
    {state && Array.from({ length: state.cap }, (_, i) => i + 1).map(id => {
      const slot = state.slots.find(s => s.id === id)
      return <div key={id}>Slot {id} · {slot?.preparing ? 'preparing' : slot?.owner ?? 'available'} {slot?.revision?.slice(0, 8)}
        <button className="btn" disabled={busy || slot?.preparing || !slot?.revision && bytes === undefined} onClick={() => void run(() => window.genio.api.playSelectSlot(world, id))}>Use slot {id}</button>
        {slot?.owner && state.selected !== id && <button className="btn" disabled={busy || slot.preparing} onClick={() => void run(() => window.genio.api.playSelectSlot(world, id, true))}>Take over slot {id}</button>}
      </div>
    })}
    {!!state?.queue.length && <p>Queue: {state.queue.join(', ')}. Retry Use slot within 30 seconds to keep your place.</p>}
  </details>
}
