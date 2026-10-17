import { GenerationSettings } from '../components/GenerationSettings'
import { useEffect, useState } from 'react'
import { FolderOpen, RefreshCw, Trash, Upload } from 'lucide-react'
import type { PushStatus } from '@shared/api'
import { modeSourceOf } from '@shared/vocab'
import type { Engine, Project, ProjectCommands, ProjectMode } from '@shared/types'
import { cheapModelsAllowed } from '@shared/dispatch'
import { settingAnchor } from '@shared/settings-index'
import type { SettingsPageId } from '@shared/settings-pages'
import { SettingsTitle } from '../components/SettingsTitle'
import { MODE_PRESETS, USAGE_MODES, USAGE_MODE_LABEL, type UsageMode } from '@shared/usage-mode'
import { PROJECT_WINDOW, api, errText, op, toast, useStore } from '../store'
import { CommitInput, Confirm, Field, Modal, Toggle } from '../components/ui'
import { ENGINES, ENGINE_LABEL, MODE_HINT, MODE_LABEL, PROJECT_MODES, isActive } from '../lib/vocab'
import { ago, cx } from '../lib/format'
import { detectedView, effectiveEngine, proposalLine } from '@shared/engine'
import { supportsUnitySlots } from '@shared/play'
import { UnitySlots } from './UnitySlots'
import { worldPath, modifiedLabel } from '../lib/worlds'
import type { WorldMetadata } from '@shared/api'

export type ProjectPageId = Extract<SettingsPageId, 'project' | 'project-delivery' | 'project-commands' | 'project-assets' | 'project-unity'>

/** Commands units and checks run. The run command (Playtest only) is no longer shown; a stored one is kept as is. */
const COMMANDS: (keyof ProjectCommands)[] = ['setup', 'build', 'test', 'lint']
const COMMAND_HINT: Record<string, string> = {
  setup: 'Prepares a fresh copy, e.g. npm ci.',
  build: 'Builds the project, e.g. dotnet build.',
  test: 'The test suite, e.g. npm test.',
  lint: 'Style and static checks, e.g. eslint .'
}

/** Delivery choices keep the game name first, then say what it does. */
const DELIVERY_OPTION: Record<ProjectMode, string> = {
  'no-mistakes': 'Hardcore: full checks and review, then a PR',
  'direct-PR': 'Standard: the unit opens a PR itself',
  'local-only': 'Offline: a local branch, merged on your word',
  'no-mistakes-prod-only': 'Hardcore (prod): Hardcore for product work, Standard for tooling'
}

const projectUpdate =(p: Project, patch: Partial<Project>): void => { void op('Project', () => api().projectUpdate(p.name, patch)) }

/** This project › General: what the project is, how it counts against limits, and removal. */
function ProjectGeneral({ p, metadata }: { p: Project; metadata?: WorldMetadata }) {
  const units = useStore((s) => s.snap.tasks.filter((t) => t.project === p.name && isActive(t.state)).length)
  const total = useStore((s) => s.snap.tasks.filter((t) => t.project === p.name && t.state !== 'cleaned').length)
  const globalMode: UsageMode = useStore((s) => s.settings?.usageMode) ?? 'balanced'
  const [remove, setRemove] = useState(false)
  const [delClone, setDelClone] = useState(false)
  const update = (patch: Partial<Project>): void => projectUpdate(p, patch)
  return <>
    <div className="project-facts">
      <div className="project-folder">
        <span className="mono mute" title={worldPath(p)}>{worldPath(p)}</span>
        <button className="btn sm ghost" title="Reveal in Explorer" onClick={() => void api().openPath(p.path)}>
          <FolderOpen size={13} /> Reveal in Explorer
        </button>
      </div>
      <p className="mute">{ENGINE_LABEL[p.engine]} {metadata?.engineVersion} · {modifiedLabel(metadata?.lastCommitAt)} · {units} active / {total} units · {p.defaultBranch} · {p.remote ?? 'No remote'}</p>
    </div>
    <section className="world-details" aria-label={`${p.name} settings`}>
      <EngineDetected p={p} />
      <Field label="Description" id={settingAnchor('Description')} hint="A one-liner about the game. Genio and units read it for context."><CommitInput value={p.description ?? ''} placeholder="Describe this project" onCommit={(v) => update({ description: v })} /></Field>
      <div className="world-controls">
        <Field label="Usage mode for this project" id={settingAnchor('Usage mode for this project')} hint="How much of your plans units here may use."><select className="select" value={p.usageMode ?? ''} onChange={(e) => update({ usageMode: (e.target.value || undefined) as UsageMode | undefined, costDial: undefined })}><option value="">Same as Genio ({USAGE_MODE_LABEL[globalMode]})</option>{USAGE_MODES.map(mode => <option key={mode} value={mode}>{USAGE_MODE_LABEL[mode]}</option>)}</select></Field>
        <Field label="Max units at once" id={settingAnchor('Max units at once')} hint={`0 = only the global limit (${MODE_PRESETS[globalMode].unitCap} in ${USAGE_MODE_LABEL[globalMode]}).`}>
          <CommitInput type="number" value={p.capacity ?? 0} onCommit={(v) => update({ capacity: Math.max(0, parseInt(v, 10) || 0) })} />
        </Field>
        <Field label="Allow OpenRouter models for low-stakes work" id={settingAnchor('Allow OpenRouter models for low-stakes work')} hint="Code is sent to OpenRouter when used. Also needs an OpenRouter key and paid spend in Usage & limits.">
          <Toggle
            checked={cheapModelsAllowed(p)}
            onChange={(v) => update({ allowCheapModels: v })}
            label={cheapModelsAllowed(p) ? <span className="amber-text">On</span> : 'Off'}
          />
        </Field>
      </div>
    </section>
    <section className="danger-zone" id="settings-danger" tabIndex={-1} aria-label="Danger zone">
      <div className="label">Danger zone</div>
      <div className="sys-row">
        <div className="sys-row-label">
          <div className="sys-row-title">Remove project from Genio</div>
          <div className="mute sys-row-hint">{p.managed ? 'Genio can also delete its own clone.' : 'Your folder stays on disk.'}</div>
        </div>
        <div className="sys-row-ctl">
          <button className="btn sm ghost alert" title="Remove project" onClick={() => setRemove(true)}>
            <Trash size={13} /> Remove
          </button>
        </div>
      </div>
    </section>
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
  </>
}

/** This project › Delivery: how finished work reaches the main branch, with Sync and Push beside it. */
function ProjectDelivery({ p }: { p: Project }) {
  const [confirmYolo, setConfirmYolo] = useState(false)
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
  const update = (patch: Partial<Project>): void => projectUpdate(p, patch)
  const noRepo = p.gitRepo === false
  return <>
    <div className="world-controls">
      <Field label="Delivery" id={settingAnchor('Delivery')} hint={modeSourceOf(p) === 'auto' ? `Follows the remote · ${MODE_HINT[p.mode]}` : MODE_HINT[p.mode]}>
        <select
          className="select"
          disabled={noRepo}
          title={noRepo ? "Needs a git repo" : undefined}
          value={modeSourceOf(p) === 'auto' ? 'auto' : p.mode}
          onChange={(e) => update(e.target.value === 'auto' ? { modeSource: 'auto' } : { mode: e.target.value as ProjectMode })}
        >
          <option value="auto">Auto · {MODE_LABEL[p.mode]} (follows the remote)</option>
          {PROJECT_MODES.map((m) => (
            <option key={m} value={m} disabled={m !== 'local-only' && !p.remote}>
              {DELIVERY_OPTION[m]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Merge finished work automatically" id={settingAnchor('Merge finished work automatically')} hint="Genio merges green, in-scope Builds without asking (Auto-loot). Red, draft or risky work still waits for you.">
        <Toggle
          checked={p.yolo}
          onChange={(v) => {
            if (v) setConfirmYolo(true)
            else update({ yolo: false })
          }}
          label={p.yolo ? <span className="volt-text">On</span> : 'Off'}
        />
      </Field>
      <Field label="Branch name prefix" id={settingAnchor('Branch name prefix')} hint="Unit branches start with this, e.g. genio/fix-jump.">
        <CommitInput mono value={p.branchPrefix} onCommit={(v) => update({ branchPrefix: v })} />
      </Field>
    </div>
    <div className="project-git" id="settings-main-branch" tabIndex={-1} aria-label="Main branch">
      <div className="label">Main branch</div>
      <p>{noRepo ? 'Git actions need a git repo' : pushable ? 'Push on demand' : MODE_LABEL[p.mode]}{pushable && push && <span> · {push.ahead} commits not pushed{push.behind ? ` · ${push.behind} on origin not local` : ''}</span>}</p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn sm ghost" disabled={noRepo} title={noRepo ? "Needs a git repo" : undefined} onClick={() => void op('Sync', () => api().projectSync(p.name)).then(() => setPushTick((n) => n + 1))}>
          <RefreshCw size={12} /> Sync
        </button>
        {pushable && (
          <button
            className="btn sm ghost"
            disabled={pushing || noRepo}
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
      </div>
    </div>
    {confirmYolo && (
      <Confirm
        title={`Merge finished work automatically in ${p.name}?`}
        tone="volt"
        confirmLabel="Turn on Auto-loot"
        body="Genio will merge green, in-scope Builds in this project without asking you first. Red, pending, draft and destructive work still waits for your word."
        onConfirm={() => update({ yolo: true })}
        onClose={() => setConfirmYolo(false)}
      />
    )}
  </>
}

/** This project › Commands: what units and the Gauntlet run. Commits keep any stored run command. */
function ProjectCommandsPage({ p }: { p: Project }) {
  const setCmd = (k: keyof ProjectCommands, v: string): void => projectUpdate(p, { commands: { ...p.commands, [k]: v.trim() || undefined } })
  return <div className="world-cmds" id="settings-commands" tabIndex={-1}>
    {COMMANDS.map((k) => (
      <Field key={k} label={k} hint={COMMAND_HINT[k]}>
        <CommitInput mono value={p.commands[k] ?? ''} placeholder="—" onCommit={(v) => setCmd(k, v)} />
      </Field>
    ))}
    <p className="mute" style={{ fontSize: 12, margin: 0 }}>
      Checks & review (the Gauntlet) runs lint, build and test on every Hardcore Build.
    </p>
  </div>
}

/** Genio infers the engine: a read-only Detected line, what else the scan found, and Rescan. No picker. */
function EngineDetected({ p }: { p: Project }) {
  const [scanning, setScanning] = useState(false)
  const v = detectedView(p)
  const game = v.engine !== 'other'
  const proposal = proposalLine(p)
  return (
    <div className="field wide engine-detected" id="settings-engine" tabIndex={-1} role="group" aria-label="Engine">
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
      <span className="field-hint">Read from the project's files. Rescan after an engine upgrade.</span>
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

/** Settings › This project: one page of this window's project. Other projects are set in their own windows. */
export function ThisProjectSettings({ page = 'project' }: { page?: ProjectPageId }) {
  const project = useStore(s => s.snap.projects.find(p => p.name === PROJECT_WINDOW))
  const landed = useStore(s => s.snap.tasks.filter(task => task.project === PROJECT_WINDOW && (task.state === 'merged' || task.state === 'cleaned')).length)
  const [metadata, setMetadata] = useState<WorldMetadata>()
  useEffect(() => {
    if (page !== 'project') return
    let live = true
    setMetadata(undefined)
    if (project) void api().projectMetadata(project.name).then(value => { if (live) setMetadata(value) }).catch(() => undefined)
    return () => { live = false }
  }, [project, landed, page])
  const heading = <SettingsTitle page={page} />
  if (!project) return <>{heading}<p className="mute">Open a project from the Hub to configure it.</p></>
  return <article className="project-settings" key={project.name}>
    {heading}
    <p className="mute sys-scope">Settings saved with {project.name}. They don't affect your other projects.</p>
    {page === 'project' && <ProjectGeneral p={project} metadata={metadata} />}
    {page === 'project-delivery' && <ProjectDelivery p={project} />}
    {page === 'project-commands' && <ProjectCommandsPage p={project} />}
    {page === 'project-assets' && <GenerationSettings world={project.name} />}
    {page === 'project-unity' && (supportsUnitySlots(effectiveEngine(project).engine)
      ? <UnitySlots world={project.name} />
      : <p className="mute">Unity slots are for Unity projects only.</p>)}
  </article>
}
