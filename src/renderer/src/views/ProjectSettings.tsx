import { GenerationSettings } from '../components/GenerationSettings'
import { useState } from 'react'
import { FolderOpen, RefreshCw } from 'lucide-react'
import { modeSourceOf } from '@shared/vocab'
import type { Project, ProjectCommands, ProjectMode } from '@shared/types'
import { cheapModelsAllowed } from '@shared/dispatch'
import { settingAnchor } from '@shared/settings-index'
import type { SettingsPageId } from '@shared/settings-pages'
import { SettingsTitle } from '../components/SettingsTitle'
import { USAGE_MODES, USAGE_MODE_LABEL, type UsageMode } from '@shared/usage-mode'
import { PROJECT_WINDOW, api, errText, op, toast, useStore } from '../store'
import { CommitInput, Confirm, Field, Modal, Toggle } from '../components/ui'
import { Picker, type PickerOption } from '../components/Picker'
import { ENGINE_LABEL, MODE_LABEL, PROJECT_MODES } from '../lib/vocab'
import { detectedView, effectiveEngine, proposalLine } from '@shared/engine'
import { supportsUnitySlots } from '@shared/play'
import { UnitySlots } from './UnitySlots'

export type ProjectPageId = Extract<SettingsPageId, 'project' | 'project-delivery' | 'project-assets' | 'project-unity'>

/** Commands units and checks run, with an example each. The run command (Playtest only) is no longer shown; a stored one is kept as is. */
const COMMANDS: [keyof ProjectCommands, string][] = [['setup', 'npm ci'], ['build', 'dotnet build'], ['test', 'npm test'], ['lint', 'eslint .']]

/** How each delivery mode works, shown below the picker (wording from ARCHITECTURE.md and the glossary). */
const DELIVERY_DESCRIPTION: Record<ProjectMode, string> = {
  'no-mistakes': 'The unit commits, then the Gauntlet runs: rebase check, lint, build and test, an AI review and fix rounds with the unit. Then Genio pushes, opens the PR and waits for CI.',
  'direct-PR': 'The unit pushes its branch and opens a pull request itself. You (or Auto-loot) merge it once its checks are green.',
  'local-only': 'The unit leaves a clean local branch. After your approval (or Auto-loot) Genio fast-forwards it into your main branch on this computer. Nothing is pushed.',
  'no-mistakes-prod-only': 'Hardcore for product work, Standard for internal tooling. Mixed or uncertain work counts as product.'
}

const projectUpdate =(p: Project, patch: Partial<Project>): void => { void op('Project', () => api().projectUpdate(p.name, patch)) }

/** This project › General: the project's engine, description, limits and commands. */
function ProjectGeneral({ p }: { p: Project }) {
  const globalMode: UsageMode = useStore((s) => s.settings?.usageMode) ?? 'balanced'
  const update = (patch: Partial<Project>): void => projectUpdate(p, patch)
  const setCmd = (k: keyof ProjectCommands, v: string): void => update({ commands: { ...p.commands, [k]: v.trim() || undefined } })
  return <>
    <div className="project-folder">
      <button className="btn sm ghost" onClick={() => void api().openPath(p.path)}>
        <FolderOpen size={13} /> Reveal in Explorer
      </button>
    </div>
    <section className="world-details" aria-label={`${p.name} settings`}>
      <EngineDetected p={p} />
      <Field label="Description" id={settingAnchor('Description')}><CommitInput value={p.description ?? ''} placeholder="Describe this project" onCommit={(v) => update({ description: v })} /></Field>
      <div className="world-controls">
        <Field label="Usage mode" id={settingAnchor('Usage mode')}><select className="select" value={p.usageMode ?? ''} onChange={(e) => update({ usageMode: (e.target.value || undefined) as UsageMode | undefined, costDial: undefined })}><option value="">Same as Genio ({USAGE_MODE_LABEL[globalMode]})</option>{USAGE_MODES.map(mode => <option key={mode} value={mode}>{USAGE_MODE_LABEL[mode]}</option>)}</select></Field>
        <Field label="Max units at once" id={settingAnchor('Max units at once')} hint="0 = only the global Units at once limit.">
          <CommitInput type="number" value={p.capacity ?? 0} onCommit={(v) => update({ capacity: Math.max(0, parseInt(v, 10) || 0) })} />
        </Field>
        <Field label="OpenRouter models" id={settingAnchor('OpenRouter models')} hint="Code is sent to OpenRouter when used. Also needs an OpenRouter key and paid spend in Usage & limits.">
          <Toggle checked={cheapModelsAllowed(p)} onChange={(v) => update({ allowCheapModels: v })} />
        </Field>
      </div>
    </section>
    <section className="world-cmds" id="settings-commands" tabIndex={-1} aria-label="Commands">
      <div className="label">Commands</div>
      {COMMANDS.map(([k, example]) => (
        <Field key={k} label={k}>
          <CommitInput mono value={p.commands[k] ?? ''} placeholder={`e.g. ${example}`} onCommit={(v) => setCmd(k, v)} />
        </Field>
      ))}
    </section>
  </>
}

/**
 * Removing a project from Genio's list: a plain confirmation, delegated to the guarded service, which keeps the
 * folder and refuses while work is live. Only a clone Genio made can be deleted too. Shown from the Hub's project list.
 */
export function RemoveProject({ p, onClose }: { p: Project; onClose: () => void }) {
  const [delClone, setDelClone] = useState(false)
  return (
    <Confirm
      title={`Remove ${p.name} from the list?`}
      confirmLabel="Remove"
      body={p.managed ? <Toggle checked={delClone} onChange={setDelClone} label="Also delete Genio's clone from disk" /> : undefined}
      onConfirm={async () => {
        await op('Remove project', () => api().projectRemove(p.name, p.managed && delClone))
      }}
      onClose={onClose}
    />
  )
}

/** This project › Delivery: how finished work reaches the main branch. */
function ProjectDelivery({ p }: { p: Project }) {
  const [confirmYolo, setConfirmYolo] = useState(false)
  const update = (patch: Partial<Project>): void => projectUpdate(p, patch)
  const noRepo = p.gitRepo === false
  const options: PickerOption<ProjectMode | 'auto'>[] = [
    { value: 'auto', label: `Auto · ${MODE_LABEL[p.mode]}`, description: `Follows the remote: GitHub → Standard, otherwise Offline. ${DELIVERY_DESCRIPTION[p.mode]}` },
    ...PROJECT_MODES.map((m) => ({ value: m, label: MODE_LABEL[m], description: DELIVERY_DESCRIPTION[m],
      unavailable: m !== 'local-only' && !p.remote ? `${p.name} has no remote, so a PR cannot be opened: use Offline mode or add a remote.` : undefined }))
  ]
  return <>
    <div className="world-controls">
      <div className="field" id={settingAnchor('Delivery')} tabIndex={-1} role="group" aria-label="Delivery">
        <span className="label">Delivery</span>
        <Picker
          label="Delivery"
          disabled={noRepo}
          hint={noRepo ? 'Needs a git repo' : undefined}
          value={modeSourceOf(p) === 'auto' ? 'auto' : p.mode}
          options={options}
          onChange={(v) => update(v === 'auto' ? { modeSource: 'auto' } : { mode: v })}
        />
      </div>
      <Field label="Merge finished work automatically" id={settingAnchor('Merge finished work automatically')}>
        <Toggle
          checked={p.yolo}
          onChange={(v) => {
            if (v) setConfirmYolo(true)
            else update({ yolo: false })
          }}
        />
      </Field>
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
        <span>{game ? <>Detected: <strong>{v.summary}</strong></> : 'No game engine detected; Genio treats this as a code project'}</span>
        <button
          className="btn sm ghost"
          disabled={scanning}
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

/** The Hub's Clone dialog: a repository URL (or owner/repo) and nothing else; name and delivery are inferred. */
export function CloneProject({ onClose, onAdded }: { onClose: () => void; onAdded?: (p: Project) => Promise<void> }) {
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      title="Clone a repository"
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
                const p = await api().projectAdd({ source: source.trim() })
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
            {busy ? 'Cloning…' : 'Clone'}
          </button>
        </>
      }
    >
      <input className="input mono" aria-label="Repository URL" autoFocus value={source} placeholder="https://github.com/you/game or owner/repo" onChange={(e) => setSource(e.target.value)} />
    </Modal>
  )
}

/** Settings › This project: one page of this window's project. Other projects are set in their own windows. */
export function ThisProjectSettings({ page = 'project' }: { page?: ProjectPageId }) {
  const project = useStore(s => s.snap.projects.find(p => p.name === PROJECT_WINDOW))
  const heading = <SettingsTitle page={page} />
  if (!project) return <>{heading}<p className="mute">Open a project from the Hub to configure it.</p></>
  return <article className="project-settings" key={project.name}>
    {heading}
    {page === 'project' && <ProjectGeneral p={project} />}
    {page === 'project-delivery' && <ProjectDelivery p={project} />}
    {page === 'project-assets' && <GenerationSettings world={project.name} />}
    {page === 'project-unity' && (supportsUnitySlots(effectiveEngine(project).engine)
      ? <UnitySlots world={project.name} />
      : <p className="mute">Unity slots are for Unity projects only.</p>)}
  </article>
}
