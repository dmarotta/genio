import { useEffect, useState } from 'react'
import { ChevronRight, FolderOpen, Plus, RefreshCw } from 'lucide-react'
import { api, op, openDecisions, useStore } from '../store'
import { ENGINE_LABEL } from '../lib/vocab'
import { useNow } from '../components/ui'
import { AddProject, NewProject } from './ProjectSettings'
import { worldList, type WorldSort } from '../lib/worlds'
import { byRecent, readRecent, rememberRecent } from '../lib/recent'
import type { WorldMetadata } from '@shared/api'
import '../styles/hub.css'

/** The Hub selects projects; all work and controls live in the project window. */
export function Hub() {
  useNow(30_000)
  const choices = useStore(s => openDecisions(s))
  const projects = useStore(s => s.snap.projects)
  const booted = useStore(s => s.booted)
  const connected = useStore(s => s.connected)
  const [recent, setRecent] = useState(readRecent)
  const [adding, setAdding] = useState(false)
  const [creating, setCreating] = useState(false)
  const [opening, setOpening] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<WorldSort | 'recent'>('recent')
  const [metadata, setMetadata] = useState<Record<string, WorldMetadata>>({})
  useEffect(() => {
    let live = true
    void Promise.all(projects.map(async project => [project.name, await api().projectMetadata(project.name)] as const))
      .then(entries => { if (live) setMetadata(Object.fromEntries(entries)) }).catch(() => undefined)
    return () => { live = false }
  }, [projects])
  // Project windows' File menus open projects too; follow their recents.
  useEffect(() => {
    const sync = (): void => setRecent(readRecent())
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])
  const available = booted && connected && !opening
  const ordered = byRecent(projects, recent)
  const matching = worldList(projects, query, sort === 'recent' ? 'name' : sort, metadata)
  const visible = sort === 'recent' ? ordered.filter(project => matching.includes(project)) : matching

  const openProject = async (path: string): Promise<void> => {
    setOpening(true)
    await op('Open project', async () => {
      await api().projectOpen(path)
      setRecent(rememberRecent(path))
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
        <button className="btn" disabled={!available} onClick={() => setAdding(true)}><Plus size={16} /> Add project</button>
        <button className="btn" disabled={!available} onClick={() => setCreating(true)}><Plus size={16} /> New project</button>
        <button className="btn ghost" disabled={!available || syncing || !projects.some(project => project.gitRepo !== false)} onClick={async () => {
          setSyncing(true)
          await op('Sync all projects', () => api().projectSync())
          setSyncing(false)
        }}><RefreshCw size={16} /> Sync all</button>
      </div>
      <div className="hub-actions">
        <input className="input" aria-label="Search projects" placeholder="Search by name, path or engine" value={query} onChange={event => setQuery(event.target.value)} />
        <select className="select" aria-label="Sort projects" value={sort} onChange={event => setSort(event.target.value as WorldSort | 'recent')}>
          <option value="recent">Recent</option><option value="modified">Last modified</option><option value="name">Name</option><option value="engine">Engine</option>
        </select>
      </div>
      <section aria-labelledby="recent-projects">
        <h2 id="recent-projects" className="label dim">Recent projects</h2>
        {!booted ? <p className="mute" role="status">Loading projects…</p> : !connected ?
          <p className="alert-text" role="status">Genio’s core is not responding. Restart the app to reconnect.</p> :
          visible.length ? <div className="hub-projects">{visible.map(p =>
            <button key={p.name} className="hub-project" disabled={!available} onClick={() => void openProject(p.path)}>
              <FolderOpen size={20} className="neon-text" />
              <span className="hub-project-identity"><strong>{p.name}</strong><span className="mono mute hub-project-path" title={p.path}>{p.path}</span></span>
              {choices.some(d => d.project === p.name) && <span className="chip amber">{choices.filter(d => d.project === p.name).length} choices waiting</span>}
              <span className="dim hub-project-engine">{ENGINE_LABEL[p.engine]}</span>
              <ChevronRight size={16} className="mute" />
            </button>
          )}</div> : <p className="mute">{query ? `No projects match "${query}".` : "No recent projects. Open a folder or create your first project."}</p>}
      </section>
      {adding && <AddProject onClose={() => setAdding(false)} onAdded={p => openProject(p.path)} />}
      {creating && <NewProject onClose={() => setCreating(false)} onCreated={p => openProject(p.path)} />}
    </div>
  </div>
}
