import { useState } from 'react'
import { ChevronRight, FolderOpen, Plus } from 'lucide-react'
import { api, op, openDecisions, useStore } from '../store'
import { ENGINE_LABEL } from '../lib/vocab'
import { useNow } from '../components/ui'
import { NewWorld } from './Worlds'
import '../styles/hub.css'

const RECENT_KEY = 'genio.hub.recent-projects'

function readRecent(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : []
  } catch { return [] }
}

/** The Hub selects projects; all work and controls live in the project window. */
export function Hub() {
  useNow(30_000)
  const choices = useStore(s => openDecisions(s))
  const projects = useStore(s => s.snap.projects)
  const booted = useStore(s => s.booted)
  const connected = useStore(s => s.connected)
  const [recent, setRecent] = useState(readRecent)
  const [creating, setCreating] = useState(false)
  const [opening, setOpening] = useState(false)
  const available = booted && connected && !opening
  const ordered = [...projects].sort((a, b) => {
    const rank = (path: string) => { const i = recent.indexOf(path); return i < 0 ? recent.length : i }
    return rank(a.path) - rank(b.path) || b.addedAt.localeCompare(a.addedAt) || a.name.localeCompare(b.name)
  })

  const openProject = async (path: string): Promise<void> => {
    setOpening(true)
    await op('Open project', async () => {
      await api().projectOpen(path)
      const next = [path, ...recent.filter(p => p !== path)].slice(0, 100)
      setRecent(next)
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)) } catch { /* Storage is optional. */ }
    })
    setOpening(false)
  }

  return <div className="hub-view">
    <div className="hub-content">
      <h1>Choose a project</h1>
      <p className="dim">Open a project to continue with Genio.</p>
      <div className="hub-actions">
        <button className="btn solid" disabled={!available} onClick={() => void op('Open folder', async () => {
          const folder = await api().pickDirectory()
          if (folder) await openProject(folder)
        })}><FolderOpen size={16} /> Open folder…</button>
        <button className="btn" disabled={!available} onClick={() => setCreating(true)}><Plus size={16} /> New project</button>
      </div>
      <section aria-labelledby="recent-projects">
        <h2 id="recent-projects" className="label dim">Recent projects</h2>
        {!booted ? <p className="mute" role="status">Loading projects…</p> : !connected ?
          <p className="alert-text" role="status">Genio’s core is not responding. Restart the app to reconnect.</p> :
          ordered.length ? <div className="hub-projects">{ordered.map(p =>
            <button key={p.name} className="hub-project" disabled={!available} onClick={() => void openProject(p.path)}>
              <FolderOpen size={20} className="neon-text" />
              <span className="hub-project-identity"><strong>{p.name}</strong><span className="mono mute hub-project-path" title={p.path}>{p.path}</span></span>
              {choices.some(d => d.project === p.name) && <span className="chip amber">{choices.filter(d => d.project === p.name).length} choices waiting</span>}
              <span className="dim hub-project-engine">{ENGINE_LABEL[p.engine]}</span>
              <ChevronRight size={16} className="mute" />
            </button>
          )}</div> : <p className="mute">No recent projects. Open a folder or create your first project.</p>}
      </section>
      {creating && <NewWorld onClose={() => setCreating(false)} onCreated={p => openProject(p.path)} />}
    </div>
  </div>
}
