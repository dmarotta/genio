import { useEffect, useState } from 'react'
import { ownerLabel, PLAYER_INSTANCE_ANCHOR, slotStatus, slotsInUse, UNITY_SLOTS_ANCHOR, type PlayPoolState, type PlaySlot } from '@shared/play'
import type { Task } from '@shared/types'
import { api, errText, useStore } from '../store'
import { Confirm, Field } from '../components/ui'
import { requestSystemsSection } from '../lib/settings-nav'

const CAPS = [1, 2, 3, 4, 5, 6, 7, 8]
const gb = (bytes: number): string => bytes < 1024 ** 3 ? `${Math.round(bytes / 1024 ** 2)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`

function statusText(slot: PlaySlot | undefined, tasks: Pick<Task, 'id' | 'title'>[]): string {
  switch (slotStatus(slot)) {
    case 'stuck': return `Stuck: its editor would not close (${slot!.stuck!.reason})`
    case 'closing': return 'Closing its editor'
    case 'preparing': return `Preparing a copy for ${ownerLabel(slot!.owner ?? '', tasks)}`
    case 'leased': return `Leased by ${ownerLabel(slot!.owner!, tasks)}`
    case 'editor': return 'Free · editor running'
    case 'retired': return 'Retired · kept for reuse if the cap rises'
    default: return 'Free'
  }
}

/** Settings › This project › Unity slots: the shared slot pool units play and test in, for Unity projects. */
export function UnitySlots({ world }: { world: string }) {
  const tasks = useStore(s => s.snap.tasks)
  const [state, setState] = useState<PlayPoolState>()
  const [disk, setDisk] = useState<Record<number, number>>()
  const [estimate, setEstimate] = useState<number>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [closing, setClosing] = useState<PlaySlot>()
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    const poll = async (): Promise<void> => {
      try { const s = await api().playPool(world); if (live) { setState(s); setError('') } }
      catch (e) { if (live) setError(errText(e)) }
    }
    void poll()
    const timer = setInterval(() => void poll(), 5000)
    return () => { live = false; clearInterval(timer) }
  }, [world, tick])
  // Disk scans walk whole copies: once on open and after each change, not every poll.
  useEffect(() => {
    let live = true
    void (async () => { try { const d = await api().playPoolDisk(world); if (live) setDisk(d) } catch { /* sizes are informational */ } })()
    return () => { live = false }
  }, [world, tick])
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try { await fn(); setError('') } catch (e) { setError(errText(e)) } finally { setBusy(false); setTick(n => n + 1) }
  }

  const used = state ? slotsInUse(state) : 0
  const draining = state?.slots.filter(s => s.draining) ?? []
  const ids = state ? [...new Set([...CAPS.slice(0, state.cap), ...state.slots.map(s => s.id)])].sort((a, b) => a - b) : []
  const totalDisk = disk ? Object.values(disk).reduce((a, b) => a + b, 0) : undefined
  return <section id={UNITY_SLOTS_ANCHOR} tabIndex={-1} className="world-generation unity-slots" aria-label="Unity slots">
    <p className="mute">Separate copies of this project, each with its own Unity editor, so units can play different branches at once. Units wait in line when every slot is busy.</p>
    {error && <p role="alert" className="alert-text">{error}</p>}
    {!state ? <p className="mute">{error ? 'Unity slots are unavailable right now.' : 'Loading Unity slots…'}</p> : <>
      <div className="form-grid">
        <Field label="Maximum slots" hint="Applies at once. Lowering it never closes anything: slots above the new cap finish their current work, then close and stay on disk for reuse.">
          <select className="select" aria-label="Maximum Unity slots" disabled={busy} value={state.cap} onChange={(e) => { const cap = Number(e.target.value); void run(() => api().playPoolCap(world, cap)) }}>
            {CAPS.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        <Field label="Slot editor windows" hint="Hidden keeps every slot editor off your screen and never steals focus. Visible opens the next slot editors as normal windows, to see a stuck dialog while debugging.">
          <select className="select" aria-label="Slot editor windows" disabled={busy} value={state.launch ?? 'hidden'} onChange={(e) => { const visible = e.target.value === 'visible'; void run(() => api().playPoolLaunch(world, visible)) }}>
            <option value="hidden">Hidden (recommended)</option>
            <option value="visible">Visible, for debugging</option>
          </select>
        </Field>
        <Field label="In use" hint={totalDisk !== undefined ? `${gb(totalDisk)} on disk across all slot copies` : undefined}>
          <span className="unity-slots-count">{used} of {state.cap} slots in use{draining.length ? ` · ${draining.length} draining` : ''}{state.queue.length ? ` · ${state.queue.length} waiting` : ''}</span>
        </Field>
      </div>
      {draining.length > 0 && <p className="amber-text">Draining: slot {draining.map(s => s.id).join(', ')}. {draining.length === 1 ? 'It keeps its current lease and editor, takes no new lease, and closes its editor when released.' : 'They keep their current leases and editors, take no new lease, and close their editors when released.'}</p>}
      <ul className="unity-slot-list" aria-label="Slots">
        {ids.map(id => {
          const slot = state.slots.find(s => s.id === id)
          const status = slotStatus(slot)
          return <li key={id} className={`unity-slot ${status}${slot?.draining ? ' draining' : ''}`} data-status={status}>
            <strong>Slot {id}</strong>
            <span>{statusText(slot, tasks)}{slot?.draining ? ' · draining' : ''}{slot?.editor && status !== 'editor' && status !== 'closing' ? ' · editor running' : ''}{slot?.window === 'visible' ? ' · visible window' : ''}</span>
            <span className="mute mono">{slot?.revision?.slice(0, 8) ?? 'not prepared'}{disk?.[id] !== undefined ? ` · ${gb(disk[id])}` : ''}</span>
            {slot?.warning && <span className="amber-text">{slot.warning}</span>}
            {slot?.failure && !slot.owner && <span className="alert-text">{slot.failure.message}</span>}
            {slot && (slot.editor || slot.stuck) && <button className="btn sm ghost alert" disabled={busy || slot.preparing || slot.closing} onClick={() => setClosing(slot)}>Close slot editor</button>}
          </li>
        })}
      </ul>
      {state.queue.length > 0
        ? <p className="mute">Waiting: {state.queue.map((o, i) => `${i + 1}. ${ownerLabel(o, tasks)}`).join(' · ')}. Each takes the next free slot within the cap.</p>
        : <p className="mute">Nobody is waiting for a slot.</p>}
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <button className="btn sm" disabled={busy} onClick={() => void run(async () => setEstimate(await api().playPoolEstimate(world)))}>Estimate a new slot</button>
        {estimate !== undefined && <span className="mute">About {gb(estimate)} per new slot, plus future imports. Only committed files are copied; preparing can take several minutes.</span>}
      </div>
    </>}
    <p className="mute unity-play-link">
      Your own Play editor settings apply to all projects.{' '}
      <button className="link-btn" onClick={() => requestSystemsSection('play', PLAYER_INSTANCE_ANCHOR)}>Unity &amp; Play →</button>
    </p>
    {closing && <Confirm
      title={`Close the Unity editor in slot ${closing.id}?`}
      tone="alert"
      confirmLabel="Close slot editor"
      body={<p>Unsaved changes in that slot copy are lost.{closing.owner ? ` ${ownerLabel(closing.owner, tasks)} loses its lease and must lease a slot again.` : ''} Genio asks Unity to quit first and stops only that slot&apos;s own editor processes.</p>}
      onConfirm={() => run(() => api().playCloseSlotEditor(world, closing.id))}
      onClose={() => setClosing(undefined)}
    />}
  </section>
}
