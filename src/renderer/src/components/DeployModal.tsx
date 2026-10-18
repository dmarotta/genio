import { useEffect, useMemo, useState } from 'react'
import { Box, Radar, Rocket, SlidersHorizontal, Sparkles } from 'lucide-react'
import type { DeliveryMode, Loadout, TaskCategory, TaskKind } from '@shared/types'
import { CATEGORIES, categoryLabel } from '@shared/dispatch'
import { api, errText, focusTask, setState, toast, useStore } from '../store'
import { Field, Modal, Toggle } from './ui'
import { DELIVERY_MODES, EFFORTS, MODE_HINT, MODE_LABEL } from '../lib/vocab'
import { cx } from '../lib/format'
import { playSfx } from '../lib/sfx'
import { UnitKindIcon } from './UnitKind'

export function DeployModal() {
  const draft = useStore((s) => s.deploy)
  const projects = useStore((s) => s.snap.projects)
  const settings = useStore((s) => s.settings)
  const [kind, setKind] = useState<TaskKind>('ship')
  const [modeller, setModeller] = useState(false)
  /** A Build that runs asset generation jobs; never together with modeller. */
  const [generator, setGenerator] = useState(false)
  /** Whether a local Blender was found (a Modeller needs one); null until the toolchain answers. */
  const [blender, setBlender] = useState<boolean | null>(null)
  // Units always deploy into this window's project (openDeploy prefills it; main enforces it).
  const project = draft?.project ?? projects[0]?.name ?? ''
  const [title, setTitle] = useState('')
  const [intent, setIntent] = useState('')
  const [spec, setSpec] = useState('')
  const [showSpec, setShowSpec] = useState(false)
  const [mode, setMode] = useState<DeliveryMode | ''>('')
  const [yolo, setYolo] = useState(false)
  const [harness, setHarness] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [category, setCategory] = useState<TaskCategory | ''>('')
  const [base, setBase] = useState('')
  /** Spend the player approves up front (USD); blank: the unit asks before any paid call. */
  const [budget, setBudget] = useState('')
  const [busy, setBusy] = useState(false)
  const [override, setOverride] = useState(false)
  const [preview, setPreview] = useState<Loadout | null>(null)

  useEffect(() => {
    if (!draft) return
    setKind(draft.kind ?? 'ship')
    setModeller(draft.kind !== 'scout' && !!draft.modeller)
    setGenerator(draft.kind !== 'scout' && !draft.modeller && !!draft.generator)
    setTitle(draft.title ?? '')
    setIntent(draft.intent ?? '')
    setSpec(draft.spec ?? '')
    setShowSpec(!!draft.spec)
    setMode(draft.mode ?? '')
    setHarness(draft.harness ?? '')
    setModel(draft.model ?? '')
    setEffort(draft.effort ?? '')
    setCategory(draft.category ?? '')
    setBase(draft.baseBranch ?? '')
    setBudget('')
    setOverride(Boolean(draft.harness || draft.model || draft.effort))
    setYolo(draft.yolo ?? projects.find((x) => x.name === project)?.yolo ?? false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  useEffect(() => {
    if (!modeller || blender !== null) return
    let live = true
    void api().toolchain().then((tools) => live && setBlender(tools.some((x) => x.name === 'blender' && x.found))).catch(() => live && setBlender(null))
    return () => {
      live = false
    }
  }, [modeller, blender])

  const proj = projects.find((p) => p.name === project)
  const harnesses = useMemo(() => (settings?.harnesses ?? []).filter((h) => h.enabled), [settings])
  const h = harnesses.find((x) => x.id === (harness || preview?.harness || settings?.defaultHarness))
  const pickHarness = override ? harness : ''
  const pickModel = override ? model.trim() : ''
  const pickEffort = override ? effort : ''
  const custom = Boolean(pickHarness || pickModel || pickEffort)

  // Live preview of the auto loadout; debounced so typing the ask doesn't spam the main process.
  useEffect(() => {
    if (!draft || !project) return setPreview(null)
    let live = true
    const t = setTimeout(() => {
      api()
        .previewLoadout({
          kind,
          modeller: kind === 'ship' && modeller,
          project,
          title,
          intent,
          spec: spec || undefined,
          category: category || undefined,
          harness: pickHarness || undefined,
          model: pickModel || undefined,
          effort: pickEffort || undefined
        })
        .then((l) => live && setPreview(l))
        .catch(() => live && setPreview(null))
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [draft, kind, modeller, project, title, intent, spec, category, pickHarness, pickModel, pickEffort, settings])

  if (!draft) return null
  const toolName = (id: string): string => settings?.harnesses.find((x) => x.id === id)?.name ?? id
  const close = (): void => setState({ deploy: null })
  const asModeller = kind === 'ship' && modeller
  const asGenerator = kind === 'ship' && !modeller && generator
  const noBlender = asModeller && blender === false
  const budgetUsd = budget.trim() ? Number(budget) : undefined
  const badBudget = budgetUsd !== undefined && !(Number.isFinite(budgetUsd) && budgetUsd >= 0)
  const valid = project && proj?.gitRepo !== false && title.trim() && intent.trim() && !noBlender && !badBudget
  const pick = (k: TaskKind, flavor?: 'modeller' | 'generator'): void => {
    setKind(k)
    setModeller(flavor === 'modeller')
    setGenerator(flavor === 'generator')
  }
  const kindWord = asModeller ? 'Modeller' : asGenerator ? 'Generator' : kind === 'ship' ? 'Build' : 'Recon'

  const deployNow = async (): Promise<void> => {
    if (!valid) return
    setBusy(true)
    try {
      const t = await api().spawnTask({
        kind,
        project,
        title: title.trim(),
        intent: intent.trim(),
        spec: spec.trim() || undefined,
        category: category || undefined,
        mode: kind === 'ship' && mode ? mode : undefined,
        yolo: kind === 'ship' ? yolo : undefined,
        baseBranch: base.trim() || undefined,
        harness: pickHarness || undefined,
        model: pickModel || undefined,
        effort: pickEffort || undefined,
        backlogId: draft.backlogId,
        workspace: draft.workspace,
        ...(asModeller ? { modeller: true } : {}),
        ...(asGenerator ? { generator: true } : {}),
        ...(budgetUsd ? { approvedBudget: { usd: budgetUsd, via: 'dialog' as const } } : {})
      })
      playSfx('spawn', settings)
      toast('success', 'Unit deployed', `${t.title} is on the field`)
      close()
      focusTask(t.id)
    } catch (e) {
      toast('error', 'Deploy refused', errText(e))
      playSfx('error', settings)
    } finally {
      setBusy(false)
    }
  }

  const briefGenio = async (): Promise<void> => {
    if (!project || !intent.trim()) return
    const text = `${kindWord} in ${project}${title.trim() ? ` — ${title.trim()}` : ''}:\n\n${intent.trim()}${mode ? `\n\n(mode: ${MODE_LABEL[mode]})` : ''}`
    setBusy(true)
    try {
      await api().sendChat(draft.workspace ?? 'main', text)
      playSfx('send', settings)
      close()
      setState({ view: 'comms' })
    } catch (e) {
      toast('error', 'Could not reach Genio', errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      kicker="Deploy"
      title={`New ${kindWord} mission`}
      onClose={close}
      width={680}
      tone={asModeller ? 'orange' : asGenerator ? 'magenta' : kind === 'ship' ? 'neon' : 'violet'}
      footer={
        <>
          <button className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button
            className="btn"
            disabled={busy || !project || !intent.trim()}
            onClick={() => void briefGenio()}
            title="Let Genio scope it, pick posture and deploy"
          >
            Brief Genio
          </button>
          <button
            className={cx('btn solid', kind === 'scout' && 'violet', asModeller && 'orange', asGenerator && 'magenta')}
            disabled={busy || !valid}
            title={noBlender ? 'Install Blender 4.2 LTS or newer (free)' : undefined}
            onClick={() => void deployNow()}
          >
            <UnitKindIcon t={{ kind, modeller: asModeller, generator: asGenerator }} size={14} />
            Deploy now
          </button>
        </>
      }
    >
      <div className="kind-switch">
        <button className={cx('kind-opt', kind === 'ship' && !asModeller && !asGenerator && 'on')} onClick={() => pick('ship')}>
          <Rocket size={18} />
          <div>
            <b>Build</b>
            <span>Ships a change through the project's delivery mode</span>
          </div>
        </button>
        <button className={cx('kind-opt orange', asModeller && 'on')} onClick={() => pick('ship', 'modeller')}>
          <Box size={18} />
          <div>
            <b>Modeller</b>
            <span>{noBlender ? 'Install Blender 4.2 LTS or newer (free)' : 'Builds a 3D model in Blender steps you watch live'}</span>
          </div>
        </button>
        <button className={cx('kind-opt magenta', asGenerator && 'on')} onClick={() => pick('ship', 'generator')}>
          <Sparkles size={18} />
          <div>
            <b>Generator</b>
            <span>Runs asset generation jobs (images, sounds, 3D, motions) and places the files</span>
          </div>
        </button>
        <button className={cx('kind-opt violet', kind === 'scout' && 'on')} onClick={() => pick('scout')}>
          <Radar size={18} />
          <div>
            <b>Recon</b>
            <span>Investigates and leaves a written report, no PR</span>
          </div>
        </button>
      </div>

      <div className="form-grid">
        <Field label="Title" hint={proj?.gitRepo === false ? 'Unit creation needs a git repo' : undefined}>
          <input className="input" value={title} placeholder="e.g. Fix double-jump on slopes" onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Your words" hint="Becomes the unit's acceptance criteria. Say it like you'd say it to a teammate." wide>
          <textarea
            className="textarea"
            rows={5}
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            placeholder="What should happen, and anything that's out of bounds."
          />
        </Field>
        {showSpec ? (
          <Field label="Genio spec (optional)" hint="Build instructions only this ask requires." wide>
            <textarea className="textarea mono" rows={3} value={spec} onChange={(e) => setSpec(e.target.value)} />
          </Field>
        ) : (
          <button className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => setShowSpec(true)}>
            + Add spec
          </button>
        )}
      </div>

      <hr className="divider" />

      <div className="form-grid cols-3">
        {kind === 'ship' && (
          <Field label="Delivery" hint={mode ? MODE_HINT[mode] : proj ? `Project default: ${MODE_LABEL[proj.mode]}` : undefined}>
            <select className="select" value={mode} onChange={(e) => setMode(e.target.value as DeliveryMode | '')}>
              <option value="">Project default</option>
              {DELIVERY_MODES.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m]}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Approved spend (USD)" hint={badBudget ? 'Enter an amount, like 0.50, or leave it blank.' : 'Paid calls (FAL, Uthana) up to this amount. Blank: the unit asks you first. Codex images are free.'}>
          <input className="input" aria-label="Approved spend (USD)" inputMode="decimal" value={budget} placeholder="Ask me" aria-invalid={badBudget} onChange={(e) => setBudget(e.target.value)} />
        </Field>
        <Field label="Base branch">
          <input className="input mono" value={base} placeholder={proj?.defaultBranch ?? 'main'} onChange={(e) => setBase(e.target.value)} />
        </Field>
        {kind === 'ship' && (
          <Field label="Auto-loot" hint="Genio merges green, in-scope work without asking">
            <Toggle checked={yolo} onChange={setYolo} label={yolo ? 'On' : 'Off'} />
          </Field>
        )}
      </div>

      <div className={cx('loadout', custom && 'open')}>
        <div className="loadout-head">
          <span className="label">Loadout</span>
          <span className={cx('chip', custom ? 'amber' : 'neon')}>{custom ? 'Custom' : 'Auto'}</span>
          <select
            className="select compact"
            value={category}
            title="Dispatch category: picks the row of the category table"
            onChange={(e) => setCategory(e.target.value as TaskCategory | '')}
          >
            <option value="">{preview && !category ? `Auto · ${categoryLabel(preview.category)}` : 'Auto category'}</option>
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <span className="loadout-pick">
            {preview ? (
              <>
                <b>{toolName(preview.harness)}</b>
                <span className="dim">
                  {' '}
                  · {preview.model || 'tool default model'} · {preview.effort ? `${preview.effort} effort` : 'tool default effort'}
                </span>
              </>
            ) : (
              <span className="mute">Pick a project to see the loadout</span>
            )}
          </span>
          <button
            className="btn sm ghost"
            onClick={() => setOverride((v) => !v)}
            title={override ? 'Back to the automatic pick' : 'Choose the unit tool, model and effort yourself'}
          >
            {override ? <Sparkles size={12} /> : <SlidersHorizontal size={12} />}
            {override ? 'Auto' : 'Override'}
          </button>
        </div>
        {preview && (
          <ul className="loadout-why">
            {preview.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        )}
        {override && (
          <div className="form-grid cols-3">
            <Field label="Unit tool">
              <select className="select" value={harness} onChange={(e) => setHarness(e.target.value)}>
                <option value="">Auto</option>
                {harnesses.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                    {x.verified ? '' : ' (unverified)'}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Model">
              <input className="input" list="deploy-models" value={model} placeholder="Auto" onChange={(e) => setModel(e.target.value)} />
              <datalist id="deploy-models">
                {(h?.models ?? []).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
            <Field label="Effort">
              <select className="select" value={effort} onChange={(e) => setEffort(e.target.value)}>
                <option value="">Auto</option>
                {EFFORTS.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}
      </div>
    </Modal>
  )
}
