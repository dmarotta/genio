import { useEffect, useState } from 'react'
import { FolderOpen, LogIn, Plus, RefreshCw, Trash } from 'lucide-react'
import { api, op, useStore } from '../store'
import { AddProject, RemoveProject } from './ProjectSettings'
import { AccountSession } from '../components/AccountSession'
import { worldList } from '../lib/worlds'
import { byRecent, readRecent, rememberRecent } from '../lib/recent'
import { GENIO_CODEX, type WorldMetadata } from '@shared/api'
import type { Project } from '@shared/types'
import '../styles/hub.css'

/**
 * The Hub is only a dialog for opening a project: it shows no project's work, and closes once a project window opens.
 * While neither Claude nor Codex is signed in it lists the projects but opens none, and offers both sign-ins.
 */
export function Hub() {
  const projects = useStore(s => s.snap.projects)
  const booted = useStore(s => s.booted)
  const connected = useStore(s => s.connected)
  const gate = useStore(s => s.signInGate)
  const [session, setSession] = useState<string | null>(null)
  const [recent, setRecent] = useState(readRecent)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<Project | null>(null)
  const [opening, setOpening] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [query, setQuery] = useState('')
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
  const canOpen = available && !gate
  const matching = worldList(projects, query, metadata)
  const visible = byRecent(projects, recent).filter(project => matching.includes(project))

  const openProject = async (path: string): Promise<void> => {
    setOpening(true)
    await op('Open project', async () => {
      await api().projectOpen(path)
      setRecent(rememberRecent(path))
    })
    setOpening(false)
  }

  // The same login flows as Accounts & keys: Claude's own login, and Genio's own Codex home (same ChatGPT account).
  const signIn = async (tool: string): Promise<void> => {
    await op('Sign in', async () => {
      if (session) await api().terminalKill(session).catch(() => undefined)
      setSession((await api().accountSession(tool, 'login')).id)
    })
  }
  const closeSession = (): void => {
    if (session) void api().terminalKill(session).catch(() => undefined)
    setSession(null)
  }

  return <div className="hub-view">
    <div className="hub-content">
      <h1>Choose a project</h1>
      {gate && <div className="hub-sign-in" role="status">
        <p>Sign in with Claude or Codex to open a project.</p>
        <div className="hub-sign-in-actions">
          <button className="btn solid" onClick={() => void signIn('claude')}><LogIn size={16} /> Sign in with Claude</button>
          <button className="btn solid" onClick={() => void signIn(GENIO_CODEX)}><LogIn size={16} /> Sign in with Codex</button>
        </div>
        {session && <AccountSession id={session} onClose={closeSession} />}
      </div>}
      <div className="hub-actions">
        <button className="btn solid" disabled={!canOpen} onClick={() => void op('Open folder', async () => {
          const folder = await api().pickDirectory()
          if (folder) await openProject(folder)
        })}><FolderOpen size={16} /> Open folder…</button>
        <button className="btn" disabled={!canOpen} onClick={() => setAdding(true)}><Plus size={16} /> Add project</button>
        <button className="btn ghost" disabled={!available || syncing || !projects.some(project => project.gitRepo !== false)} onClick={async () => {
          setSyncing(true)
          await op('Sync all projects', () => api().projectSync())
          setSyncing(false)
        }}><RefreshCw size={16} /> Sync all</button>
      </div>
      <div className="hub-actions">
        <input className="input" aria-label="Search projects" placeholder="Search projects" value={query} onChange={event => setQuery(event.target.value)} />
      </div>
      <section aria-label="Recent projects">
        {!booted ? <p className="mute" role="status">Loading projects…</p> : !connected ?
          <p className="alert-text" role="status">Genio’s core is not responding. Restart the app to reconnect.</p> :
          visible.length ? <div className="hub-projects">{visible.map(p =>
            <div key={p.name} className="hub-project-row">
              <button className="hub-project" disabled={!canOpen} onClick={() => void openProject(p.path)}>
                <FolderOpen size={20} className="neon-text" />
                <span className="hub-project-identity"><strong>{p.name}</strong><span className="mono mute hub-project-path" title={p.path}>{p.path}</span></span>
              </button>
              <button className="btn ghost icon hub-project-remove" disabled={!available} title={`Remove ${p.name} from Genio`} aria-label={`Remove ${p.name} from Genio`} onClick={() => setRemoving(p)}>
                <Trash size={14} />
              </button>
            </div>
          )}</div> : <p className="mute">{query ? `No projects match "${query}".` : "No recent projects. Open a folder, even an empty one."}</p>}
      </section>
      {adding && <AddProject onClose={() => setAdding(false)} onAdded={p => openProject(p.path)} />}
      {removing && <RemoveProject p={removing} onClose={() => setRemoving(null)} />}
    </div>
  </div>
}
