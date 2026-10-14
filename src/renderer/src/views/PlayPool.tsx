import { useEffect, useState } from 'react'
import { ownerLabel, slotStatus, slotsInUse, UNITY_SLOTS_ANCHOR, type PlayPoolState } from '@shared/play'
import { go, useStore } from '../store'
import { requestSystemsSection } from './Systems'

/**
 * Play screen target picker: main editor or a slot, and take over. The pool itself (cap, slot
 * states, closing editors) is configured in Settings › This project › Unity slots.
 */
export function PlayPoolPanel({ world, onChange, onError }: { world: string; onChange: () => void; onError: (error: string) => void }) {
  const tasks = useStore(s => s.snap.tasks)
  const [state, setState] = useState<PlayPoolState>()
  const [busy, setBusy] = useState(false)
  const [wanted, setWanted] = useState<number>()
  useEffect(() => {
    let closed = false
    const poll = async () => { try { const s = await window.genio.api.playPool(world); if (!closed) setState(s) } catch(e) { if (!closed) onError(String(e)) } }
    void poll(); const timer = setInterval(() => void poll(), 5000)
    return () => { closed = true; clearInterval(timer) }
  }, [world])
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); setWanted(undefined); onChange() } catch(e) { onError(String(e)) } finally { setState(await window.genio.api.playPool(world).catch(() => state)); setBusy(false) } }
  const select = (id: number) => {
    const slot = state?.slots.find(s => s.id === id)
    // Leased by someone else: take over only on an explicit second click.
    if (id && slot?.owner && state?.selected !== id) { setWanted(id); return }
    setWanted(undefined)
    void run(() => window.genio.api.playSelectSlot(world, id || undefined))
  }
  const target = wanted !== undefined ? state?.slots.find(s => s.id === wanted) : undefined
  const settings = () => { requestSystemsSection('project', UNITY_SLOTS_ANCHOR); go('systems') }
  const stuck = state?.slots.filter(s => s.stuck) ?? []
  const draining = state?.slots.filter(s => s.draining).length ?? 0
  return <>
    {stuck.map(s => <p key={s.id} role="alert" className="alert-text">Slot {s.id} is stuck: its Unity editor would not close ({s.stuck!.reason}). Units cannot use it until it is closed. <button className="btn sm ghost" onClick={settings}>Open Unity slots</button></p>)}
    <div className="play-target">
    <label>Target <select aria-label="Play target" disabled={busy || !state} value={wanted ?? state?.selected ?? 0} onChange={e => select(Number(e.target.value))}>
      <option value={0}>Main editor</option>
      {state && Array.from({ length: state.cap }, (_, i) => i + 1).map(id => {
        const slot = state.slots.find(s => s.id === id), status = slotStatus(slot)
        const note = status === 'leased' ? (state.selected === id ? 'yours' : ownerLabel(slot!.owner!, tasks)) : status
        return <option key={id} value={id} disabled={['stuck', 'closing', 'preparing'].includes(status) && state.selected !== id}>Slot {id} · {note}</option>
      })}
    </select></label>
    {target?.owner && <>
      <span>Slot {target.id} is leased by {ownerLabel(target.owner, tasks)}.</span>
      <button className="btn" disabled={busy || target.preparing} onClick={() => void run(() => window.genio.api.playSelectSlot(world, target.id, true))}>Take over slot {target.id}</button>
      <button className="btn ghost" disabled={busy} onClick={() => setWanted(undefined)}>Cancel</button>
    </>}
    {state && <button className="btn ghost play-slots-link" title="Unity slots in Settings › This project" onClick={settings}>{slotsInUse(state)} of {state.cap} slots in use{draining ? ` · ${draining} draining` : ''}</button>}
  </div>
  </>
}
