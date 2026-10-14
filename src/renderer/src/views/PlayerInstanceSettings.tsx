import { useEffect, useState } from 'react'
import type { PlayerInstanceStatus, PlayerMachineStatus } from '@shared/play'
import { api, errText } from '../store'
import { Field } from '../components/ui'

const gb = (n: number) => `${(n / 2 ** 30).toFixed(1)} GB`
/** Lifecycle settings only; the source picker and the live game are on the Play screen. */
export function PlayerInstanceSettings({ world }: { world: string }) {
  const [instance, setInstance] = useState<PlayerInstanceStatus>()
  const [machine, setMachine] = useState<PlayerMachineStatus>()
  const [size, setSize] = useState<number>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true, polling = false
    const poll = async () => {
      if (polling) return
      polling = true
      try {
        const [i, m] = await Promise.all([api().playerInstanceStatus(world), api().playerInstanceMachine(world)])
        if (live) { setInstance(i); setMachine(m) }
      } catch (e) { if (live) setError(errText(e)) }
      finally { polling = false }
    }
    void poll(); const timer = setInterval(() => void poll(), 5000)
    return () => { live = false; clearInterval(timer) }
  }, [world])
  // Full copy sizes are deliberately measured once per copy, rather than on every heartbeat.
  useEffect(() => {
    let live = true; setSize(undefined)
    if (instance?.copy) void api().playerCopySizes(world).then(s => { if (live) setSize(s.totalBytes) }).catch(() => {})
    return () => { live = false }
  }, [world, instance?.copy?.id])
  const change = async (patch: Parameters<ReturnType<typeof api>['playerInstanceSettings']>[1]) => {
    setBusy(true)
    try { const settings = await api().playerInstanceSettings(world, patch); setMachine(m => m && { ...m, settings }); setError('') }
    catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }
  const source = instance?.copy?.source
  return <div className="player-instance-settings">
    <h4>Your Play instance</h4>
    <p className="mute">One editor for this project window. Stop keeps Unity warm; when Unity quits, its copy is deleted in the background.</p>
    {error && <p role="alert" className="alert-text">{error}</p>}
    {machine && <>
      <div className="form-grid">
        <Field label="Quit after idle" hint="Minutes after Stop. 0 quits immediately. Applies to warm editors already open.">
          <input className="input" aria-label="Player idle minutes" type="number" min={0} max={60} value={machine.settings.idleMinutes} disabled={busy} onChange={e => { const n = Number(e.target.value); if (e.target.value && Number.isInteger(n) && n >= 0 && n <= 60) void change({ idleMinutes: n }) }} />
        </Field>
        <Field label="Maximum player editors" hint="Across all project windows. Idle editors can be closed to make room; playing editors are kept. Each start also checks free memory.">
          <select className="select" aria-label="Maximum player editors" value={machine.settings.maxEditors} disabled={busy} onChange={e => void change({ maxEditors: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5, 6, 7, 8].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
      </div>
      <p className="mute">Genio Unity editors: {machine.totalEditors} running ({machine.unitEditors} unit slots, {machine.playerEditors} player, {machine.batchEditors} batch) · {gb(machine.workingSetBytes)} · {gb(machine.freeBytes)} free of {gb(machine.totalBytes)}</p>
    </>}
    {instance && <p>{instance.state.replace(/-/g, ' ')}{source ? ` · ${source.kind === 'checkout' ? source.branch ?? source.path : source.ref}` : ''}{instance.deadline ? ` · quits in ${Math.max(0, Math.ceil((instance.deadline - Date.now()) / 60000))} min` : ''}{size !== undefined ? ` · ${gb(size)} on disk` : ''}{instance.copy?.state === 'pending-delete' || instance.copy?.state === 'deleting' ? ' · deleting copy in the background' : ''}</p>}
    {instance?.message && <p className="alert-text">{instance.message}</p>}
  </div>
}
