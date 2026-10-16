import { useEffect, useState } from 'react'
import { PLAYER_INSTANCE_ANCHOR, type PlayerMachineStatus } from '@shared/play'
import { api, errText } from '../store'
import { Field } from '../components/ui'

const gb = (n: number) => `${(n / 2 ** 30).toFixed(1)} GB`
/**
 * Settings › Unity & Play: lifecycle settings stored once for every project; the source picker, the live game and
 * the instance's status are on the Play screen only. `world` is any registered Unity project (the service checks it).
 */
export function PlayerInstanceSettings({ world }: { world: string }) {
  const [machine, setMachine] = useState<PlayerMachineStatus>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true, polling = false
    const poll = async () => {
      if (polling) return
      polling = true
      try { const m = await api().playerInstanceMachine(world); if (live) setMachine(m) }
      catch (e) { if (live) setError(errText(e)) }
      finally { polling = false }
    }
    void poll(); const timer = setInterval(() => void poll(), 5000)
    return () => { live = false; clearInterval(timer) }
  }, [world])
  const change = async (patch: Parameters<ReturnType<typeof api>['playerInstanceSettings']>[1]) => {
    setBusy(true)
    try { const settings = await api().playerInstanceSettings(world, patch); setMachine(m => m && { ...m, settings }); setError('') }
    catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }
  return <section id={PLAYER_INSTANCE_ANCHOR} tabIndex={-1} className="world-generation player-instance-settings" aria-label="Your Play editor">
    <h4>Your Play editor</h4>
    <p className="mute">One editor per project window, opened from Play. Stop keeps Unity warm; when Unity quits, its copy is deleted in the background. These settings apply to all projects.</p>
    {error && <p role="alert" className="alert-text">{error}</p>}
    {machine && <>
      <div className="form-grid">
        <Field label="Close your Play editor after (minutes)" hint="Minutes idle after Stop, e.g. 10; 0 closes at once.">
          <input className="input" aria-label="Close your Play editor after (minutes)" type="number" min={0} max={60} value={machine.settings.idleMinutes} disabled={busy} onChange={e => { const n = Number(e.target.value); if (e.target.value && Number.isInteger(n) && n >= 0 && n <= 60) void change({ idleMinutes: n }) }} />
        </Field>
        <Field label="Play editors open at once" hint="Across all project windows. Idle editors close to make room; playing ones are kept. Each start also checks free memory.">
          <select className="select" aria-label="Play editors open at once" value={machine.settings.maxEditors} disabled={busy} onChange={e => void change({ maxEditors: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5, 6, 7, 8].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
      </div>
      <p className="mute">Genio Unity editors: {machine.totalEditors} running ({machine.unitEditors} unit slots, {machine.playerEditors} player, {machine.batchEditors} batch) · {gb(machine.workingSetBytes)} · {gb(machine.freeBytes)} available of {gb(machine.totalBytes)}</p>
    </>}
  </section>
}
