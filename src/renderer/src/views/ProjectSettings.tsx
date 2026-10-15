import { GenerationSettings } from '../components/GenerationSettings'
import { useEffect, useState } from 'react'
import { Backpack, ChevronDown, ChevronRight, FolderOpen, RefreshCw, Rocket, Trash, Upload } from 'lucide-react'
import type { PushStatus } from '@shared/api'
import { modeSourceOf } from '@shared/vocab'
import type { Engine, Project, ProjectCommands, ProjectMode } from '@shared/types'
import { cheapModelsAllowed } from '@shared/dispatch'
import { requestSystemsSection } from './Systems'
import { USAGE_MODES, USAGE_MODE_LABEL, type UsageMode } from '@shared/usage-mode'
import { PROJECT_WINDOW, api, errText, go, hasView, op, openDeploy, setState, toast, useStore } from '../store'
import { CommitInput, Confirm, Field, Modal, Toggle } from '../components/ui'
import { ENGINES, ENGINE_LABEL, MODE_HINT, MODE_LABEL, PROJECT_MODES, isActive } from '../lib/vocab'
import { ago, cx } from '../lib/format'
import { detectedLine, detectedView, effectiveEngine, proposalLine } from '@shared/engine'
import { supportsUnitySlots } from '@shared/play'
import { UnitySlots } from './UnitySlots'
import { worldPath, modifiedLabel } from '../lib/worlds'
import type { WorldMetadata } from '@shared/api'

/** Editable project commands. A stored `run` (retired with Playtest) is kept but not offered. */
const COMMANDS: (keyof ProjectCommands)[] = ['setup', 'build', 'test', 'lint']

export function ProjectSettingsRow({ p, metadata }: { p: Project; metadata?: WorldMetadata }) {
  const units = useStore((s) => s.snap.tasks.filter((t) => t.project === p.name && isActive(t.state)).length)
  const total = useStore((s) => s.snap.tasks.filter((t) => t.project === p.name && t.state !== 'cleaned').length)
  const [open, setOpen] = useState(false)
  const [confirmYolo, setConfirmYolo] = useState(false)
  const [remove, setRemove] = useState(false)
  const [delClone, setDelClone] = useState(false)
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

  const update = (patch: Partial<Project>): void => {
    void op('Project', () => api().projectUpdate(p.name, patch))
  }
  const setCmd = (k: keyof ProjectCommands, v: string): void => {
    update({ commands: { ...p.commands, [k]: v.trim() || undefined } })
  }

  return (
    <article className="project-settings">
      <h3>{p.name}</h3>
      <p className="mono mute" title={worldPath(p)}>{worldPath(p)}</p>
      <p className="mute">{ENGINE_LABEL[p.engine]} {metadata?.engineVersion} · {modifiedLabel(metadata?.lastCommitAt)} · {units} active / {total} units · {p.defaultBranch} · {p.remote ?? 'No remote'}</p>
      <p>{p.gitRepo === false ? 'Git actions need a git repo' : pushable ? 'Push on demand' : MODE_LABEL[p.mode]}{pushable && push && <span> · {push.ahead} commits not pushed{push.behind ? ` · ${push.behind} on origin not local` : ''}</span>}</p>
      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 20 }}>
          <button className="btn sm solid" onClick={() => void op('Open project', () => api().projectOpen(p.path))}><FolderOpen size={13} /> Open</button>
          <span title={hasView('inventory') ? `Open ${p.name} Inventory` : 'Inventory coming soon'}><button className="btn sm solid" disabled={!hasView('inventory')} onClick={() => go('inventory')}><Backpack size={13} /> Inventory</button></span>
        <button className="btn sm solid" disabled={p.gitRepo === false} title={p.gitRepo === false ? "Needs a git repo" : undefined} onClick={() => openDeploy({ project: p.name })}>
          <Rocket size={12} /> Deploy
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
        <button className="btn sm ghost alert" title="Remove project" onClick={() => setRemove(true)}>
          <Trash size={13} /> Remove
        </button>

      </div>
      <section className="world-details" aria-label={`${p.name} settings`}>
        <EngineDetected p={p} />
        <Field label="Usage mode" hint="Override the global usage mode for this project"><select className="select" value={p.usageMode ?? ''} onChange={(e) => update({ usageMode: (e.target.value || undefined) as UsageMode | undefined, costDial: undefined })}><option value="">Global setting</option>{USAGE_MODES.map(mode => <option key={mode} value={mode}>{USAGE_MODE_LABEL[mode]}</option>)}</select></Field>
        <Field label="Description"><CommitInput value={p.description ?? ''} placeholder="Describe this project" onCommit={(v) => update({ description: v })} /></Field>
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
          {COMMANDS.filter((k) => p.commands[k]).length} set
        </span>
      </button>
      {open && (
        <div className="world-cmds">
          {COMMANDS.map((k) => (
            <Field key={k} label={k}>
              <CommitInput mono value={p.commands[k] ?? ''} placeholder="—" onCommit={(v) => setCmd(k, v)} />
            </Field>
          ))}
          <p className="mute" style={{ fontSize: 12, margin: 0 }}>
            The Gauntlet runs lint, build and test on every Hardcore Build.
          </p>
        </div>
      )}

      <GenerationSettings world={p.name} />
      {supportsUnitySlots(effectiveEngine(p).engine) && <UnitySlots world={p.name} />}
      </section>

      {confirmYolo && (
        <Confirm
          title={`Enable Auto-loot for ${p.name}?`}
          tone="volt"
          confirmLabel="Enable Auto-loot"
          body="Genio will merge green, in-scope Builds in this project without asking you first. Red, pending, draft and destructive work still waits for your word."
          onConfirm={() => update({ yolo: true })}
          onClose={() => setConfirmYolo(false)}
        />
      )}
      {remove && (
        <Confirm
          title={`Remove ${p.name}?`}
          tone="alert"
          typed={p.name}
          confirmLabel="Remove project"
          body={
            <>
              <p>Genio refuses while units are working, quests are queued, or any isolated copy holds unlanded work.</p>
              {p.managed && (
                <Toggle checked={delClone} onChange={setDelClone} label="Also delete Genio's clone from disk" />
              )}
              {!p.managed && <p className="mute">This project is your own folder; Genio never deletes it.</p>}
            </>
          }
          onConfirm={async () => {
            await op('Remove project', () => api().projectRemove(p.name, p.managed && delClone))
          }}
          onClose={() => setRemove(false)}
        />
      )}
    </article>
  )
}

/** Genio infers the engine: a read-only Detected line, what else the scan found, and Rescan. No picker. */
function EngineDetected({ p }: { p: Project }) {
  const [scanning, setScanning] = useState(false)
  const v = detectedView(p)
  const game = v.engine !== 'other'
  const proposal = proposalLine(p)
  return (
    <div className="field wide engine-detected" role="group" aria-label="Engine">
      <span className="label">Engine</span>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span>{game ? <>Detected: <strong>{v.summary}</strong>{v.declared && <span className="mute"> (set in .genio/project.json)</span>}</> : 'No game engine detected; Genio treats this as a code project'}</span>
        <span className="mute">·</span>
        <button
          className="btn sm ghost"
          disabled={scanning}
          title={v.scannedAt ? `Last scanned ${ago(v.scannedAt)}` : 'Look for the engine again'}
          onClick={async () => {
            setScanning(true)
            await op('Rescan', () => api().projectRescan(p.name))
            setScanning(false)
          }}
        >
          <RefreshCw size={12} /> {scanning ? 'Scanning…' : 'Rescan'}
        </button>
      </div>
      {v.others.length > 0 && <span className="field-hint">Also found: {v.others.join('; ')}.{v.ambiguous ? ' Ask Genio to pin one.' : ''}</span>}
      {v.warning && <span className="field-hint amber-text">{v.warning}</span>}
      {proposal && (
        <span className="field-hint amber-text">
          {proposal}{' '}
          <button className="btn sm ghost" onClick={() => void op('Engine proposal', () => api().projectUpdate(p.name, { engineProposal: undefined }))}>Dismiss</button>
        </span>
      )}
    </div>
  )
}

export function AddProject({ onClose, onAdded }: { onClose: () => void; onAdded?: (p: Project) => Promise<void> }) {
  const [source, setSource] = useState('')
  const [name, setName] = useState('')
  const [inPlace, setInPlace] = useState(true)
  const [mode, setMode] = useState<ProjectMode | ''>('')
  const [busy, setBusy] = useState(false)
  const isLocal = /^[a-zA-Z]:[\\/]|^[\\/]|^\./.test(source.trim())
  return (
    <Modal
      kicker="Load project"
      title="Add a project"
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
                toast('success', 'Project loaded', `${p.name} · ${ENGINE_LABEL[p.engine]}`)
                onClose()
                await onAdded?.(p)
              } catch (e) {
                toast('error', 'Could not add project', errText(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? 'Loading…' : 'Add project'}
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

export function NewProject({ onClose, onCreated }: { onClose: () => void; onCreated?: (p: Project) => Promise<void> }) {
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
      title="Create a project"
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
                toast('success', 'Project created', p.name)
                onClose()
                await onCreated?.(p)
              } catch (e) {
                toast('error', 'Could not create project', errText(e))
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
        <Field label="Scaffold for" hint="Sets up .gitignore and AGENTS.md. Genio detects the engine once its project files exist.">
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
  const proposal = project && proposalLine(project)
  if (!project || (!registered && !proposal && project.gitRepo !== false)) return null
  const view = detectedView(project)
  return <div role="status" className="project-notice">
    <span className="project-notice-text">{registered ? `Registered ${project.name} · ${detectedLine(view)}${view.ambiguous ? ' · ambiguous' : ''} · ${MODE_LABEL[project.mode]}` : project.name}
      {project.gitRepo === false ? ' · Git actions need a git repo' : !project.remote ? ' · No remote' : ''}
      {proposal && <span className="amber-text"> · {proposal}</span>}</span>
    {(registered || proposal) && <button className="btn sm ghost" onClick={() => { requestSystemsSection('project'); go('systems') }}>{registered ? 'Change' : 'Settings'}</button>}
    {registered && <button className="btn sm ghost" aria-label="Dismiss registration" onClick={() => setState({ registeredProject: undefined })}>Dismiss</button>}
    {!registered && proposal && <button className="btn sm ghost" aria-label="Dismiss engine proposal" onClick={() => void op('Engine proposal', () => api().projectUpdate(project.name, { engineProposal: undefined }))}>Dismiss</button>}
  </div>
}

export function ThisProjectSettings() {
  const project = useStore(s => s.snap.projects.find(p => p.name === PROJECT_WINDOW))
  const landed = useStore(s => s.snap.tasks.filter(task => task.project === PROJECT_WINDOW && (task.state === 'merged' || task.state === 'cleaned')).length)
  const [metadata, setMetadata] = useState<WorldMetadata>()
  useEffect(() => {
    let live = true
    setMetadata(undefined)
    if (project) void api().projectMetadata(project.name).then(value => { if (live) setMetadata(value) }).catch(() => undefined)
    return () => { live = false }
  }, [project, landed])
  return <><h2 className="sys-title">This project</h2>{project ? <ProjectSettingsRow key={project.name} p={project} metadata={metadata} /> : <p className="mute">Open a project from the Hub to configure it.</p>}</>
}
