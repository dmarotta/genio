import { GenerationSettings } from '../components/GenerationSettings'
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FolderOpen, Gamepad2, Globe, MoreHorizontal, Package, Settings, Search, Play, Plus, RefreshCw, Rocket, Sparkles, Trash, Upload, Users } from 'lucide-react'
import type { PushStatus } from '@shared/api'
import { modeSourceOf } from '@shared/vocab'
import type { CostDial, Engine, Project, ProjectCommands, ProjectMode } from '@shared/types'
import { DIAL_HINT, DIAL_LABEL, cheapModelsAllowed } from '@shared/dispatch'
import { PROJECT_WINDOW, api, errText, go, hasView, op, openDeploy, setState, spawnWorldAllyChat, toast, useStore } from '../store'
import { CommitInput, Confirm, Empty, Field, Modal, Toggle, ViewHeader } from '../components/ui'
import { ENGINES, ENGINE_COLOR, ENGINE_LABEL, MODE_HINT, MODE_LABEL, PROJECT_MODES, isActive } from '../lib/vocab'
import { cx } from '../lib/format'
import { allyForWorld } from '../lib/dock'
import { worldList, worldPath, modifiedLabel, type WorldSort } from '../lib/worlds'
import type { WorldMetadata } from '@shared/api'

export function Worlds() {
  const projects = useStore((s) => s.snap.projects)
  const highlight = useStore((s) => s.highlightWorld)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<WorldSort>('modified')
  const [metadata, setMetadata] = useState<Record<string, WorldMetadata>>({})
  const landed = useStore((s) => s.snap.tasks.filter((t) => t.state === 'merged' || t.state === 'cleaned').length)
  useEffect(() => {
    let live = true
    void Promise.all(projects.map(async (p) => [p.name, await api().projectMetadata(p.name)] as const))
      .then((entries) => { if (live) setMetadata(Object.fromEntries(entries)) }).catch(() => undefined)
    return () => { live = false }
  }, [projects, landed])
  const visible = worldList(projects, query, sort, metadata)
  const [adding, setAdding] = useState(false)
  const [creating, setCreating] = useState(false)
  const [syncing, setSyncing] = useState(false)

  return (
    <div className="view worlds-view">
      <ViewHeader
        kicker={`${projects.length} world${projects.length === 1 ? '' : 's'} loaded`}
        title={
          <>
            <span className="accent">Worlds</span>
          </>
        }
      >
        <button className="btn solid" onClick={() => void op('Open folder', async () => {
          const folder = await api().pickDirectory()
          if (folder) await api().projectOpen(folder)
        })}><FolderOpen size={14} /> Open folder…</button>
        <button
          className="btn ghost"
          disabled={syncing || !projects.some(p => p.gitRepo !== false)}
          onClick={async () => {
            setSyncing(true)
            await op('Sync all', () => api().projectSync())
            setSyncing(false)
          }}
        >
          <RefreshCw size={14} className={syncing ? 'spin' : ''} /> Sync all
        </button>
        <button className="btn" onClick={() => setCreating(true)}>
          <Sparkles size={14} /> New world
        </button>
        <button className="btn solid" onClick={() => setAdding(true)}>
          <Plus size={14} /> Add world
        </button>
      </ViewHeader>

      <div className="world-toolbar">
        <label className="world-search"><Search size={15} /><input className="input" aria-label="Search worlds" placeholder="Search worlds by name, path or engine" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <select className="select" aria-label="Sort worlds" value={sort} onChange={(e) => setSort(e.target.value as WorldSort)}>
          <option value="modified">Last modified</option><option value="name">Name</option><option value="engine">Engine</option>
        </select>
      </div>
      {projects.length === 0 ? (
        <Empty icon={<Globe size={44} className="neon-text" />} title="No worlds loaded">
          Point Genio at a game repo — a URL, owner/repo, or a folder on disk — or start a fresh one.
          <div style={{ marginTop: 16, display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button className="btn" onClick={() => setCreating(true)}>
              New world
            </button>
            <button className="btn solid" onClick={() => setAdding(true)}>
              Add world
            </button>
          </div>
        </Empty>
      ) : (
        <div className="world-list">
          <div className="world-columns" aria-hidden="true"><span>World</span><span>Engine</span><span>Last modified</span><span>Delivery</span><span>Actions</span></div>
          {visible.map((p) => (
            <WorldRow key={p.name} p={p} metadata={metadata[p.name]} highlight={highlight === p.name} />
          ))}
          {!visible.length && <p className="world-no-results dim">No worlds match "{query}". <button className="btn sm ghost" onClick={() => setQuery('')}>Clear search</button></p>}
        </div>
      )}
      {adding && <AddWorld onClose={() => setAdding(false)} />}
      {creating && <NewWorld onClose={() => setCreating(false)} />}
    </div>
  )
}

function WorldRow({ p, highlight, metadata }: { p: Project; highlight: boolean; metadata?: WorldMetadata }) {
  const [settings, setSettings] = useState(false)
  const units = useStore((s) => s.snap.tasks.filter((t) => t.project === p.name && isActive(t.state)).length)
  const total = useStore((s) => s.snap.tasks.filter((t) => t.project === p.name && t.state !== 'cleaned').length)
  const [open, setOpen] = useState(false)
  const [confirmYolo, setConfirmYolo] = useState(false)
  const [remove, setRemove] = useState(false)
  const [delClone, setDelClone] = useState(false)
  const ally = useStore((s) => allyForWorld(s.snap.allies, p.name))
  const [spawning, setSpawning] = useState(false)
  const ref = useRef<HTMLElement>(null)
  // Offline worlds with a remote push on demand: show what origin is missing.
  const pushable = p.mode === 'local-only' && !!p.remote
  const landed = useStore((s) => s.snap.tasks.filter((t) => t.project === p.name && (t.state === 'merged' || t.state === 'cleaned')).length)
  const [push, setPush] = useState<PushStatus | undefined>()
  const [pushTick, setPushTick] = useState(0)
  const [pushing, setPushing] = useState(false)
  useEffect(() => {
    if (!pushable) {
      setPush(undefined)
      return
    }
    let live = true
    api()
      .projectPushStatus(p.name)
      .then((s) => live && setPush(s))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [pushable, p.name, p.defaultBranch, landed, pushTick])

  useEffect(() => {
    if (highlight && ref.current) {
      setSettings(true)
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
      const t = window.setTimeout(() => setState({ highlightWorld: undefined }), 2000)
      return () => window.clearTimeout(t)
    }
    return undefined
  }, [highlight])

  const update = (patch: Partial<Project>): void => {
    void op('World', () => api().projectUpdate(p.name, patch))
  }
  const setCmd = (k: keyof ProjectCommands, v: string): void => {
    update({ commands: { ...p.commands, [k]: v.trim() || undefined } })
  }

  return (
    <article ref={ref} className={cx('world-list-item', highlight && 'hl')} style={{ ['--eng' as string]: ENGINE_COLOR[p.engine] }}>
      <div className="world-summary" onClick={() => setSettings((v) => !v)}>
        <button className="world-identity" aria-expanded={settings} aria-controls={`settings-${p.name}`} onClick={(e) => { e.stopPropagation(); setSettings((v) => !v) }}>
          <Gamepad2 className="world-engine-icon" size={22} />
          <span><strong>{p.name}</strong><span className="world-root mono mute" title={worldPath(p)}>{worldPath(p)}</span></span>
        </button>
        <span className="world-engine-cell">{ENGINE_LABEL[p.engine]}<small className="mute">{metadata?.engineVersion ?? ''}</small></span>
        <span className="dim world-modified" title={metadata?.lastCommitAt}>{modifiedLabel(metadata?.lastCommitAt)}</span>
        <span className="world-delivery">{p.gitRepo === false && <small className="amber-text">Git actions need a git repo</small>}<span className="world-badge">{pushable ? 'Push on demand' : MODE_LABEL[p.mode]}</span>{pushable && <small className="mute">{push ? `${push.ahead} commits not pushed` : 'Checking...'}</small>}{!!push?.behind && <small className="amber-text">{push.behind} on origin not local</small>}</span>
        <div className="world-actions" style={{ flexWrap: 'wrap' }} onClick={(e) => e.stopPropagation()}>
          <button className="btn sm solid" onClick={() => void op('Open project', () => api().projectOpen(p.path))}><FolderOpen size={13} /> Open</button>
          <span title={hasView('inventory') ? `Open ${p.name} Inventory` : 'Inventory coming soon'}><button className="btn sm solid" disabled={!hasView('inventory')} onClick={() => go('inventory', { world: p.name })}><Package size={13} /> Inventory</button></span>
          <button className="btn sm violet" disabled={spawning} title={ally ? `Open ally ${ally.name}` : 'Spawn ally'} onClick={async () => { setSpawning(true); await spawnWorldAllyChat(p.name); setSpawning(false) }}><Users size={13} />{spawning ? 'Spawning...' : 'Ally'}</button>
          <details className="world-menu" onKeyDown={(e) => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus() } }}>
            <summary className="btn sm ghost icon" aria-label={`Actions for ${p.name}`}><MoreHorizontal size={17} /></summary>
            <div className="world-menu-items" onClick={(e) => { const menu = e.currentTarget.closest('details'); if (menu) menu.open = false }}>
              <button className="btn sm ghost" onClick={() => setSettings(true)}><Settings size={13} /> Settings</button>
        <button className="btn sm solid" disabled={p.gitRepo === false} title={p.gitRepo === false ? "Needs a git repo" : undefined} onClick={() => openDeploy({ project: p.name })}>
          <Rocket size={12} /> Deploy
        </button>
        <button className="btn sm volt" disabled={!p.commands.run} title={p.commands.run ?? 'Set a run command first'} onClick={() => void op('Playtest', () => api().playtest({ project: p.name }), (r) => (r ? 'Playtest launched in Squad › Sessions' : undefined))}>
          <Play size={12} /> Playtest
        </button>
        <button className="btn sm ghost" disabled={p.gitRepo === false} title={p.gitRepo === false ? "Needs a git repo" : undefined} onClick={() => void op('Sync', () => api().projectSync(p.name)).then(() => setPushTick((n) => n + 1))}>
          <RefreshCw size={12} /> Sync
        </button>
        {pushable && (
          <button
            className="btn sm ghost"
            disabled={pushing || p.gitRepo === false}
            title={`Push ${p.defaultBranch} to origin (fast-forward only, never forced)`}
            onClick={async () => {
              setPushing(true)
              await op('Push', () => api().projectPush(p.name))
              setPushing(false)
              setPushTick((n) => n + 1)
            }}
          >
            <Upload size={12} /> {pushing ? 'Pushing…' : 'Push'}
          </button>
        )}
        <button className="btn sm ghost" title="Reveal in Explorer" onClick={() => void api().openPath(p.path)}>
          <FolderOpen size={13} /> Reveal in Explorer
        </button>
        <span style={{ flex: 1 }} />
        <button className="btn sm ghost alert" title="Remove world" onClick={() => setRemove(true)}>
          <Trash size={13} /> Remove
        </button>

            </div>
          </details>
        </div>
      </div>
      {settings && <section className="world-details" id={`settings-${p.name}`} aria-label={`${p.name} settings`}>
        <div className="world-details-heading"><h3>World settings</h3><span className="mute">{units} active / {total} units / {p.defaultBranch} / {p.remote ?? 'No remote'}</span><button className="btn sm ghost" onClick={() => setSettings(false)}>Close</button></div>
        <Field label="Description"><CommitInput value={p.description ?? ''} placeholder="Describe this world" onCommit={(v) => update({ description: v })} /></Field>
      <div className="world-controls">
        <Field label="Delivery" hint={modeSourceOf(p) === 'auto' ? `Follows the remote · ${MODE_HINT[p.mode]}` : MODE_HINT[p.mode]}>
          <select
            className="select"
            disabled={p.gitRepo === false}
            title={p.gitRepo === false ? "Needs a git repo" : undefined}
            value={modeSourceOf(p) === 'auto' ? 'auto' : p.mode}
            onChange={(e) => update(e.target.value === 'auto' ? { modeSource: 'auto' } : { mode: e.target.value as ProjectMode })}
          >
            <option value="auto">Auto · {MODE_LABEL[p.mode]} (follows the remote)</option>
            {PROJECT_MODES.map((m) => (
              <option key={m} value={m} disabled={m !== 'local-only' && !p.remote}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Auto-loot" hint="Genio merges green, in-scope work itself">
          <Toggle
            checked={p.yolo}
            onChange={(v) => {
              if (v) setConfirmYolo(true)
              else update({ yolo: false })
            }}
            label={p.yolo ? <span className="volt-text">On</span> : 'Off'}
          />
        </Field>
        <Field label="Capacity" hint="Max units at once (0 = no cap)">
          <CommitInput type="number" value={p.capacity ?? 0} onCommit={(v) => update({ capacity: Math.max(0, parseInt(v, 10) || 0) })} />
        </Field>
        <Field label="Branch prefix">
          <CommitInput mono value={p.branchPrefix} onCommit={(v) => update({ branchPrefix: v })} />
        </Field>
        <Field label="Cost dial" hint={p.costDial ? DIAL_HINT[p.costDial] : 'Follows Systems → Dispatch'}>
          <select className="select" value={p.costDial ?? ''} onChange={(e) => update({ costDial: (e.target.value || undefined) as CostDial | undefined })}>
            <option value="">Global setting</option>
            {(['quality', 'balanced', 'cost'] as CostDial[]).map((d) => (
              <option key={d} value={d}>
                {DIAL_LABEL[d]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Allow cheap third-party models" hint="On by default: OpenRouter models (DeepSeek, Qwen, GLM) via OpenCode for low-stakes work. Code is sent to the OpenRouter provider when used.">
          <Toggle
            checked={cheapModelsAllowed(p)}
            onChange={(v) => update({ allowCheapModels: v })}
            label={cheapModelsAllowed(p) ? <span className="amber-text">On</span> : 'Off'}
          />
        </Field>
      </div>

      <button className="world-cmds-toggle label" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Commands
        <span className="mute" style={{ textTransform: 'none', letterSpacing: 0 }}>
          {Object.values(p.commands).filter(Boolean).length} set
        </span>
      </button>
      {open && (
        <div className="world-cmds">
          {(['setup', 'build', 'test', 'lint', 'run'] as (keyof ProjectCommands)[]).map((k) => (
            <Field key={k} label={k === 'run' ? 'run (playtest)' : k}>
              <CommitInput mono value={p.commands[k] ?? ''} placeholder="—" onCommit={(v) => setCmd(k, v)} />
            </Field>
          ))}
          <p className="mute" style={{ fontSize: 12, margin: 0 }}>
            The Gauntlet runs lint, build and test on every Hardcore Build. Run launches a playtest from any unit's copy.
          </p>
        </div>
      )}

      <GenerationSettings world={p.name} />
      </section>}

      {confirmYolo && (
        <Confirm
          title={`Enable Auto-loot for ${p.name}?`}
          tone="volt"
          confirmLabel="Enable Auto-loot"
          body="Genio will merge green, in-scope Builds in this world without asking you first. Red, pending, draft and destructive work still waits for your word."
          onConfirm={() => update({ yolo: true })}
          onClose={() => setConfirmYolo(false)}
        />
      )}
      {remove && (
        <Confirm
          title={`Remove ${p.name}?`}
          tone="alert"
          typed={p.name}
          confirmLabel="Remove world"
          body={
            <>
              <p>Genio refuses while units are working, quests are queued, or any isolated copy holds unlanded work.</p>
              {p.managed && (
                <Toggle checked={delClone} onChange={setDelClone} label="Also delete Genio's clone from disk" />
              )}
              {!p.managed && <p className="mute">This world is your own folder; Genio never deletes it.</p>}
            </>
          }
          onConfirm={async () => {
            await op('Remove world', () => api().projectRemove(p.name, p.managed && delClone))
          }}
          onClose={() => setRemove(false)}
        />
      )}
    </article>
  )
}

function AddWorld({ onClose }: { onClose: () => void }) {
  const [source, setSource] = useState('')
  const [name, setName] = useState('')
  const [inPlace, setInPlace] = useState(true)
  const [mode, setMode] = useState<ProjectMode | ''>('')
  const [busy, setBusy] = useState(false)
  const isLocal = /^[a-zA-Z]:[\\/]|^[\\/]|^\./.test(source.trim())
  return (
    <Modal
      kicker="Load world"
      title="Add a world"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn solid"
            disabled={busy || !source.trim()}
            onClick={async () => {
              setBusy(true)
              try {
                const p = await api().projectAdd({ source: source.trim(), name: name.trim() || undefined, inPlace: isLocal && inPlace, mode: mode || undefined })
                toast('success', 'World loaded', `${p.name} · ${ENGINE_LABEL[p.engine]}`)
                onClose()
              } catch (e) {
                toast('error', 'Could not add world', errText(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? 'Loading…' : 'Add world'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Source" hint="Git URL, owner/repo, or a local folder" wide>
          <div className="row">
            <input className="input mono" autoFocus value={source} placeholder="https://github.com/you/game" onChange={(e) => setSource(e.target.value)} />
            <button
              className="btn icon"
              title="Pick folder"
              onClick={async () => {
                const d = await api().pickDirectory()
                if (d) setSource(d)
              }}
            >
              <FolderOpen size={16} />
            </button>
          </div>
        </Field>
        <Field label="Name (optional)">
          <input className="input" value={name} placeholder="derived from source" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Delivery">
          <select className="select" value={mode} onChange={(e) => setMode(e.target.value as ProjectMode | '')}>
            <option value="">Auto (follows the remote: GitHub → Standard, otherwise Offline)</option>
            {PROJECT_MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </select>
        </Field>
        {isLocal && (
          <Field label="Local folder" wide>
            <Toggle checked={inPlace} onChange={setInPlace} label="Use in place (Genio reads it and builds in isolated copies; never edits it directly)" />
          </Field>
        )}
      </div>
    </Modal>
  )
}

function NewWorld({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [engine, setEngine] = useState<Engine>('godot')
  const [description, setDescription] = useState('')
  const [remote, setRemote] = useState(false)
  const [priv, setPriv] = useState(true)
  const [busy, setBusy] = useState(false)
  const valid = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)
  return (
    <Modal
      kicker="New game"
      title="Create a world"
      onClose={onClose}
      width={620}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn solid"
            disabled={busy || !valid}
            onClick={async () => {
              setBusy(true)
              try {
                const p = await api().projectCreate({ name, engine, description: description.trim() || undefined, createRemote: remote, privateRemote: priv })
                toast('success', 'World created', p.name)
                onClose()
              } catch (e) {
                toast('error', 'Could not create world', errText(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Create
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Name" hint={name && !valid ? 'Letters, digits, . _ - only' : undefined}>
          <input className="input mono" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="space-goblins" />
        </Field>
        <Field label="Engine">
          <select className="select" value={engine} onChange={(e) => setEngine(e.target.value as Engine)}>
            {ENGINES.map((x) => (
              <option key={x} value={x}>
                {ENGINE_LABEL[x]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Pitch" wide>
          <textarea className="textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One-liner: what's the game?" />
        </Field>
      </div>
      <div className={cx('outward', remote && 'on')}>
        <Toggle checked={remote} onChange={setRemote} label="Also create a GitHub repository" />
        {remote && (
          <>
            <p className="amber-text" style={{ fontSize: 13, margin: '10px 0' }}>
              Outward-facing: this creates a repository on GitHub under your account and pushes to it.
            </p>
            <Toggle checked={priv} onChange={setPriv} label={priv ? 'Private repository' : 'Public repository'} />
          </>
        )}
      </div>
    </Modal>
  )
}

/** Registration is informational and dismissible; settings remain one click away. */
export function ProjectNotice() {
  const registered = useStore(s => s.registeredProject)
  const project = useStore(s => s.snap.projects.find(p => p.name === PROJECT_WINDOW))
  if (!project || (!registered && project.gitRepo !== false)) return null
  return <div role="status" style={{ padding: '8px 18px', background: 'var(--panel)', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12 }}>
    <span>{registered ? `Registered ${project.name} · ${ENGINE_LABEL[project.engine]} · ${MODE_LABEL[project.mode]}` : project.name}
      {project.gitRepo === false ? ' · Git actions need a git repo' : !project.remote ? ' · No remote' : ''}</span>
    {registered && <><button className="btn sm ghost" onClick={() => { setState({ highlightWorld: project.name }); go('worlds') }}>Change</button>
      <button className="btn sm ghost" aria-label="Dismiss registration" onClick={() => setState({ registeredProject: undefined })}>Dismiss</button></>}
  </div>
}
