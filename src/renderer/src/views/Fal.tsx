import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Ban, Copy, FolderOpen, KeyRound, Play, RotateCcw, Save, Settings2, Sparkles, Star, Trash } from 'lucide-react'
import type { ApiKeyStatus, FalCatalogue, FalCatalogueEntry, FalModelInfo, FalOutput, FalOutputKind, FalRecipe, FalRun, FalWorldConfig, FalWorldState } from '@shared/api'
import { budgetCheck, chainTargets, estimateRun, filterRuns, fmtUsd, suggestFolder, type HistoryScope } from '@shared/fal'
import {
  buildInput, fieldErrorsFromMessage, fileFieldFor, initialValues, promptField, schemaDefaults, schemaToForm, validateValues, type FormModel, type JsonSchema
} from '@shared/fal-schema'
import { api, errText, go, op, toast, useStore } from '../store'
import { Chip, Confirm, Empty, Field, Modal, Tabs, ViewHeader, useNow } from '../components/ui'
import { GlbViewer } from '../components/GlbViewer'
import { FalForm } from '../components/FalForm'
import { FalPicker, KIND_ICON } from '../components/FalPicker'
import { requestSystemsSection } from './Systems'
import { FAL_STATUS, KIND_LABEL, bytes, load, memKey, parseJsonObject, priceOf, runPrompt, store } from '../lib/fal'
import { ago, cx, usd } from '../lib/format'

type Mode = 'fields' | 'json'
type Values = Record<string, unknown>

interface Draft {
  endpoint: string
  values: Values
  mode: Mode
  json: string
  recipe?: string
  /** applied once the endpoint's schema is known */
  pending?: { fresh: boolean; values?: Values; chain?: { kind: FalOutputKind; value: string; prompt?: string } }
}

const WORLD_KEY = 'genio.fal.world'
const SCRATCH = '~scratch'

// survive view switches (the stage remounts each view)
let keptDraft: Draft | null = null
let keptSelected: string | null = null
let keptScope: HistoryScope = 'world'
const infoCache = new Map<string, FalModelInfo>()

const upsert = (list: FalRun[], r: FalRun): FalRun[] => (list.some((x) => x.id === r.id) ? list.map((x) => (x.id === r.id ? r : x)) : [r, ...list])

const openAccounts = (): void => {
  requestSystemsSection('accounts')
  go('systems')
}

function duration(from?: string, to?: string, now = Date.now()): string {
  if (!from) return ''
  const s = Math.max(0, Math.round(((to ? new Date(to).getTime() : now) - new Date(from).getTime()) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

const overridesOf = (e?: FalCatalogueEntry): { pin?: string[]; defaults?: Values; hide?: string[] } => ({ pin: e?.pin, defaults: e?.defaults, hide: e?.hide })

export function Fal() {
  const projects = useStore((s) => s.snap.projects)
  const [key, setKey] = useState<ApiKeyStatus | null | undefined>(undefined)
  const [runs, setRuns] = useState<FalRun[] | null>(null)
  const [selected, setSelected] = useState<string | null>(keptSelected)
  const [scope, setScopeState] = useState<HistoryScope>(keptScope)
  const [worldSel, setWorldSel] = useState<string | null | undefined>(() => load<string | undefined>(WORLD_KEY, undefined))
  const [catalogue, setCatalogue] = useState<FalCatalogue | null>(null)
  const [wstate, setWstate] = useState<FalWorldState | null>(null)
  const [draft, setDraftState] = useState<Draft>(() => keptDraft ?? { endpoint: '', values: {}, mode: 'fields', json: '{}', pending: { fresh: true } })
  const [info, setInfo] = useState<FalModelInfo | null>(null)
  const [infoErr, setInfoErr] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [jsonErr, setJsonErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [picker, setPicker] = useState(false)
  const [confirm, setConfirm] = useState<{ reasons: string[]; input: Values } | null>(null)
  const [saveTarget, setSaveTarget] = useState<{ run: FalRun; index: number } | null>(null)
  const [recipeOpen, setRecipeOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const lastRun = useRef<string | null>(null)

  // active world: the last one used, else the first world, else Scratch
  const world: string | null =
    worldSel === undefined ? projects[0]?.name ?? null : worldSel && worldSel !== SCRATCH && projects.some((p) => p.name === worldSel) ? worldSel : null
  const worldLabel = world ?? 'Scratch'
  const setWorld = (w: string | null): void => {
    setWorldSel(w ?? SCRATCH)
    store(WORLD_KEY, w ?? SCRATCH)
  }
  const setScope = (s: HistoryScope): void => {
    keptScope = s
    setScopeState(s)
  }

  const setDraft = (patch: Partial<Draft>): void => {
    setDraftState((d) => (keptDraft = { ...d, ...patch }))
  }

  const loadCatalogue = (refresh = false): void => {
    void api()
      .falCatalogue(world, refresh)
      .then(setCatalogue)
      .catch((e) => toast('error', 'FAL catalogue', errText(e)))
  }
  const loadWorld = (): void => {
    void api()
      .falWorld(world)
      .then(setWstate)
      .catch((e) => toast('error', 'FAL world', errText(e)))
  }

  useEffect(() => {
    void api()
      .apiKeys()
      .then((ks) => setKey(ks.find((k) => k.id === 'fal') ?? null))
      .catch(() => setKey(null))
    void api()
      .falRuns()
      .then(setRuns)
      .catch((e) => {
        toast('error', 'FAL history', errText(e))
        setRuns([])
      })
  }, [])

  useEffect(() => {
    loadCatalogue()
    loadWorld()
    return window.genio.on((ev) => {
      if (ev.type === 'fal-catalogue') loadCatalogue()
      if (ev.type !== 'fal-run') return
      setRuns((rs) => upsert(rs ?? [], ev.run))
      if (ev.run.id === lastRun.current && ev.run.status === 'failed' && ev.run.error) setErrors(fieldErrorsFromMessage(ev.run.error, Object.keys(keptDraft?.values ?? {}).concat(modelKeys.current)))
      if (!FAL_STATUS[ev.run.status].live) loadWorld()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world])

  useEffect(() => {
    keptSelected = selected
  }, [selected])

  // Ctrl+M opens the model picker focused
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        setPicker(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // first visit: start on the first curated model
  useEffect(() => {
    if (!draft.endpoint && catalogue?.entries[0]) setDraft({ endpoint: catalogue.entries[0].endpoint, pending: { fresh: true } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogue])

  // the endpoint's schema: from the catalogue cache, else fetched (and cached) by main
  useEffect(() => {
    const ep = draft.endpoint
    setInfoErr(null)
    if (!ep) return setInfo(null)
    const cached = catalogue?.info[ep]
    if (cached?.schema) {
      infoCache.set(ep, cached)
      return setInfo(cached)
    }
    if (infoCache.get(ep)?.schema) return setInfo(infoCache.get(ep)!)
    setInfo(null)
    let live = true
    void api()
      .falModel(ep)
      .then((m) => {
        infoCache.set(ep, m)
        if (live) setInfo(m)
      })
      .catch((e) => live && setInfoErr(errText(e)))
    return () => {
      live = false
    }
  }, [draft.endpoint, catalogue])

  const entry = catalogue?.entries.find((e) => e.endpoint === draft.endpoint)
  const schema = info?.endpoint === draft.endpoint ? (info.schema as JsonSchema | undefined) : undefined
  const model: FormModel = useMemo(() => schemaToForm(schema, overridesOf(entry)), [schema, entry])
  const modelKeys = useRef<string[]>([])
  modelKeys.current = model.fields.map((f) => f.key)

  // fill the form once the schema is in: defaults, remembered essentials, then recipe / reuse / chained values
  useEffect(() => {
    const p = draft.pending
    if (!p || !schema) return
    const remembered = load<Values>(memKey(world, draft.endpoint), {})
    const values: Values = { ...(p.fresh ? initialValues(model, remembered) : {}), ...(p.values ?? {}) }
    if (p.chain) {
      const f = fileFieldFor(model, p.chain.kind)
      if (f) values[f.key] = f.widget === 'files' ? [p.chain.value] : p.chain.value
      const pf = promptField(model)
      if (pf && p.chain.prompt && !values[pf.key]) values[pf.key] = p.chain.prompt
    }
    setErrors({})
    setDraft({ values, json: JSON.stringify(buildInput(values), null, 2), pending: undefined })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, draft.pending])

  const worldRuns = useMemo(() => filterRuns(runs ?? [], world, 'world'), [runs, world])
  const shown = useMemo(() => filterRuns(runs ?? [], world, scope), [runs, world, scope])
  const run = shown.find((r) => r.id === selected) ?? shown[0]

  const input = buildInput(draft.values)
  const est = estimateRun(entry, priceOf(catalogue, entry, draft.endpoint), input, schemaDefaults(schema))
  const budget = wstate?.world === world ? wstate : null

  const pick = (endpoint: string): void => {
    if (endpoint === draft.endpoint) return
    setErrors({})
    setDraft({ endpoint, values: {}, json: '{}', recipe: undefined, pending: { fresh: true } })
  }
  const useRecipe = (r: FalRecipe): void => {
    setErrors({})
    setDraft({ endpoint: r.endpoint, values: {}, recipe: r.id, mode: 'fields', pending: { fresh: true, values: r.input } })
  }
  const reuse = (r: FalRun): void => {
    setErrors({})
    setDraft({ endpoint: r.endpoint, values: {}, recipe: r.recipe, mode: 'fields', pending: { fresh: false, values: r.input } })
  }
  const chain = (r: FalRun, o: FalOutput, target: FalCatalogueEntry): void => {
    const value = o.localPath ? `@file:${o.localPath}` : o.url
    const prompt = typeof r.input.prompt === 'string' ? r.input.prompt : undefined
    setErrors({})
    setDraft({ endpoint: target.endpoint, values: {}, recipe: undefined, mode: 'fields', pending: { fresh: true, chain: { kind: o.kind, value, prompt } } })
  }

  const setValue = (k: string, v: unknown): void => {
    const values = { ...draft.values }
    if (v === undefined) delete values[k]
    else values[k] = v
    setDraft({ values })
    if (errors[k]) setErrors(({ [k]: _gone, ...rest }) => rest)
  }

  const switchMode = (m: Mode): void => {
    if (m === draft.mode) return
    if (m === 'json') {
      setJsonErr(null)
      setDraft({ mode: m, json: JSON.stringify(input, null, 2) })
    } else if (jsonErr) toast('warn', 'Fix the JSON first', jsonErr)
    else setDraft({ mode: m })
  }
  const editJson = (text: string): void => {
    try {
      const values = parseJsonObject(text)
      setJsonErr(null)
      setDraft({ json: text, values })
    } catch (e) {
      setJsonErr(errText(e))
      setDraft({ json: text })
    }
  }

  const doRun = async (body: Values): Promise<void> => {
    setBusy(true)
    const r = await op('FAL run', () => api().falRun({ endpoint: draft.endpoint, input: body, world: world ?? undefined, recipe: draft.recipe }))
    setBusy(false)
    if (!r) return
    lastRun.current = r.id
    store(memKey(world, draft.endpoint), Object.fromEntries(model.essentials.filter((f) => f.key in draft.values).map((f) => [f.key, draft.values[f.key]])))
    setRuns((rs) => upsert(rs ?? [], r))
    if (scope === 'world' && (r.world ?? null) !== world) setScope('all')
    setSelected(r.id)
    loadWorld()
  }

  const submit = (): void => {
    if (!draft.endpoint.trim() || busy) return
    if (jsonErr) {
      toast('warn', 'Fix the JSON first', jsonErr)
      return
    }
    const errs = schema ? validateValues(model, draft.values) : {}
    setErrors(errs)
    if (Object.keys(errs).length) {
      if (draft.mode === 'json') toast('warn', 'Check the parameters', Object.entries(errs).map(([k, m]) => `${k}: ${m}`).join(' · '))
      return
    }
    const check = budgetCheck(budget?.spentUsd ?? 0, est.usd, budget?.config.budget, worldLabel)
    if (check.confirm) setConfirm({ reasons: check.reasons, input })
    else void doRun(input)
  }

  const noKey = key === null || key?.set === false
  const cap = budget?.config.budget?.monthly_usd
  const unlisted = catalogue?.info[draft.endpoint]?.listed === false

  return (
    <div className="view">
      <ViewHeader
        kicker="Generative media · images · audio · 3D"
        title={
          <>
            <span className="accent">FAL</span>.ai
          </>
        }
      >
        <div className="fal-world">
          <span className="label">World</span>
          <select className="select compact" value={world ?? SCRATCH} onChange={(e) => setWorld(e.target.value === SCRATCH ? null : e.target.value)}>
            {projects.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
            <option value={SCRATCH}>Scratch (no world)</option>
          </select>
          {budget && (
            <span className={cx('fal-spend mono', cap !== undefined && budget.spentUsd >= cap && 'amber-text')} title={`Estimated spend in ${worldLabel} this month (${budget.month})`}>
              {fmtUsd(budget.spentUsd)}
              {cap !== undefined && <span className="mute"> / {fmtUsd(cap)}</span>}
              <span className="mute"> this month</span>
            </span>
          )}
          <button className="btn sm ghost icon" title={`FAL settings for ${worldLabel}: save folders and budget`} onClick={() => setSettingsOpen(true)}>
            <Settings2 size={13} />
          </button>
        </div>
        {key?.set && (
          <button className="btn sm ghost" onClick={openAccounts} title="Manage the key in Systems → Accounts">
            <KeyRound size={12} /> key set{key.last4 ? ` · ••••${key.last4}` : ''}
          </button>
        )}
      </ViewHeader>
      <div className="fal-layout">
        <div className="fal-side">
          {noKey ? (
            <section className="panel fal-compose">
              <Empty icon={<KeyRound size={34} className="amber-text" />} title="No FAL.ai key">
                Genio runs FAL requests from its core with a key kept encrypted in your base; it never reaches this screen.
                <div style={{ marginTop: 14 }}>
                  <button className="btn solid" onClick={openAccounts}>
                    Set it in Systems → Accounts
                  </button>
                </div>
              </Empty>
            </section>
          ) : (
            <section className="panel fal-compose">
              <div className="fal-model-row">
                <FalPicker
                  catalogue={catalogue}
                  recipes={budget?.recipes ?? []}
                  worldLabel={worldLabel}
                  endpoint={draft.endpoint}
                  open={picker}
                  setOpen={setPicker}
                  onPick={pick}
                  onRecipe={useRecipe}
                  onDeleteRecipe={(r) =>
                    void op('Delete recipe', () => api().falRecipeDelete(world, r.id)).then((list) => list && setWstate((s) => (s ? { ...s, recipes: list } : s)))
                  }
                  onRefresh={() => loadCatalogue(true)}
                />
                <button className="btn sm ghost icon" title={`Save these settings as a recipe in ${worldLabel}`} disabled={!draft.endpoint} onClick={() => setRecipeOpen(true)}>
                  <Star size={13} />
                </button>
              </div>
              {entry && <div className="fal-hint mute">{entry.hint}</div>}
              {unlisted && <div className="amber-text fal-hint">FAL no longer lists this endpoint; it may stop working. Pick a newer model in the same job.</div>}

              <div className="fal-params-head">
                <span className="label">Parameters</span>
                <Tabs<Mode> value={draft.mode} onChange={switchMode} tabs={[{ id: 'fields', label: 'Fields' }, { id: 'json', label: 'JSON' }]} />
              </div>
              {draft.mode === 'json' ? (
                <>
                  <textarea className="textarea mono fal-json-edit" rows={12} value={draft.json} spellCheck={false} onChange={(e) => editJson(e.target.value)} />
                  <div className="field-hint">Advanced: exactly what is sent. Keys the form doesn't know are kept. {jsonErr && <span className="alert-text">{jsonErr}</span>}</div>
                </>
              ) : schema ? (
                <FalForm model={model} values={draft.values} errors={errors} onChange={setValue} runs={worldRuns} world={world} onSubmit={submit} />
              ) : infoErr ? (
                <div className="fal-hint">
                  <span className="alert-text">Couldn't load this model's schema: {infoErr}</span>
                  <div className="mute">Use the JSON tab to send parameters by hand.</div>
                </div>
              ) : (
                <div className="bar indeterminate">
                  <i />
                </div>
              )}
              {Object.keys(errors).length > 0 && draft.mode === 'fields' && <div className="alert-text fal-err">Fix the highlighted fields before running.</div>}

              <div className="fal-run-row">
                <div className="fal-cost" title={est.units !== undefined ? `${+est.units.toFixed(3)} ${est.unit} × unit price (estimate)` : 'FAL bills this model in units Genio cannot count before the run'}>
                  <span className="label">Cost</span>
                  <span className="mono">{est.text}</span>
                </div>
                <button className="btn solid" disabled={busy || !draft.endpoint.trim() || key === undefined || !!draft.pending} onClick={submit} title="Run (Ctrl+Enter)">
                  <Play size={13} /> Run
                </button>
              </div>
            </section>
          )}
          <section className="panel fal-history">
            <div className="fal-history-head">
              <span className="label">History</span>
              <div className="fal-seg small">
                <button className={cx('fal-seg-opt', scope === 'world' && 'on')} onClick={() => setScope('world')}>
                  {worldLabel}
                </button>
                <button className={cx('fal-seg-opt', scope === 'all' && 'on')} onClick={() => setScope('all')}>
                  All
                </button>
              </div>
            </div>
            {!runs && (
              <div className="bar indeterminate">
                <i />
              </div>
            )}
            {runs && shown.length === 0 && <div className="mute side-empty">{scope === 'world' ? `No runs in ${worldLabel} yet.` : 'No runs yet.'}</div>}
            <div className="fal-history-list">
              {shown.map((r) => (
                <HistoryRow key={r.id} r={r} on={r.id === run?.id} showWorld={scope === 'all'} label={catalogue?.entries.find((e) => e.endpoint === r.endpoint)?.label} onClick={() => setSelected(r.id)} />
              ))}
            </div>
          </section>
        </div>
        <section className="panel fal-detail">
          {run ? (
            <RunDetail
              run={run}
              entries={catalogue?.entries ?? []}
              onReuse={() => reuse(run)}
              onSave={(index) => setSaveTarget({ run, index })}
              onChain={(o, t) => chain(run, o, t)}
              onDeleted={() => setSelected(null)}
            />
          ) : (
            <Empty icon={<Sparkles size={34} className="neon-text" />} title="Nothing generated yet">
              Pick a model (Ctrl+M), fill the essentials and run it. Results preview here and stay in Genio's data folder until you save them to a world.
            </Empty>
          )}
        </section>
      </div>
      {confirm && (
        <Confirm
          title="Over budget: run anyway?"
          tone="amber"
          confirmLabel="Run anyway"
          body={
            <>
              {confirm.reasons.map((r) => (
                <p key={r}>{r}</p>
              ))}
              <p className="mute">The budget warns and asks; it never blocks you. Change it with the ⚙ next to the world.</p>
            </>
          }
          onConfirm={() => doRun(confirm.input)}
          onClose={() => setConfirm(null)}
        />
      )}
      {saveTarget && <SaveToWorld run={saveTarget.run} index={saveTarget.index} activeWorld={world} onClose={() => setSaveTarget(null)} onSaved={loadWorld} />}
      {recipeOpen && (
        <RecipeModal
          world={world}
          endpoint={draft.endpoint}
          label={entry?.label}
          input={input}
          onClose={() => setRecipeOpen(false)}
          onSaved={(list, id) => {
            setWstate((s) => (s ? { ...s, recipes: list } : s))
            setDraft({ recipe: id })
          }}
        />
      )}
      {settingsOpen && <WorldSettings world={world} state={budget} onClose={() => setSettingsOpen(false)} onSaved={setWstate} />}
    </div>
  )
}

function HistoryRow({ r, on, showWorld, label, onClick }: { r: FalRun; on: boolean; showWorld: boolean; label?: string; onClick: () => void }) {
  const st = FAL_STATUS[r.status]
  const thumb = r.outputs.find((o) => o.kind === 'image' && (o.mediaUrl || o.url))
  return (
    <button className={cx('fal-hrow', on && 'on')} onClick={onClick}>
      <div className="fal-thumb">{thumb ? <img src={thumb.mediaUrl ?? thumb.url} alt="" /> : <span className="mono">{r.outputs[0]?.kind ?? '·'}</span>}</div>
      <div className="fal-hmain">
        <div className="fal-hprompt">{runPrompt(r)}</div>
        <div className="mono mute fal-hmeta">
          {showWorld && <>{r.world ?? 'scratch'} · </>}
          {label ?? r.endpoint} · {ago(r.createdAt)}
        </div>
      </div>
      <Chip tone={st.tone} pulse={st.live}>
        {st.label}
      </Chip>
    </button>
  )
}

function RunDetail({
  run,
  entries,
  onReuse,
  onSave,
  onChain,
  onDeleted
}: {
  run: FalRun
  entries: FalCatalogueEntry[]
  onReuse: () => void
  onSave: (i: number) => void
  onChain: (o: FalOutput, target: FalCatalogueEntry) => void
  onDeleted: () => void
}) {
  const st = FAL_STATUS[run.status]
  const now = useNow(st.live ? 1000 : 60_000)
  const [del, setDel] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const cost = run.costUsd ?? run.estUsd
  return (
    <div className="fal-run">
      <div className="fal-run-head">
        <div className="fal-run-title">
          <div className="mono">{run.endpoint}</div>
          <div className="mute fal-run-meta">
            {run.world ?? 'Scratch'} · {new Date(run.createdAt).toLocaleString()} · {duration(run.createdAt, run.completedAt, now)}
            {cost !== undefined && <> · {run.costUsd !== undefined ? usd(run.costUsd) : `≈ ${fmtUsd(cost)}`}</>}
            {run.requestId && <> · <span className="mono selectable">{run.requestId}</span></>}
          </div>
        </div>
        <Chip tone={st.tone} pulse={st.live}>
          {st.label}
          {run.status === 'queued' && run.queuePosition !== undefined ? ` · #${run.queuePosition + 1}` : ''}
        </Chip>
        <div className="row">
          {st.live && (
            <button
              className="btn sm alert"
              disabled={cancelling}
              onClick={async () => {
                setCancelling(true)
                await op('Cancel run', () => api().falCancel(run.id))
                setCancelling(false)
              }}
            >
              <Ban size={12} /> Cancel
            </button>
          )}
          <button className="btn sm" onClick={onReuse} title="Load this run's model and inputs into the form">
            <RotateCcw size={12} /> Reuse inputs
          </button>
          {!st.live && (
            <button className="btn sm ghost icon alert" title="Delete run and its files" onClick={() => setDel(true)}>
              <Trash size={12} />
            </button>
          )}
        </div>
      </div>
      {st.live && (
        <div className="bar indeterminate" style={{ ['--c' as string]: `var(--${st.tone})` }}>
          <i />
        </div>
      )}
      {run.error && <pre className="refusal selectable">{run.error}</pre>}
      {run.logs.length > 0 && (st.live || !run.outputs.length) && <pre className="file-pre fal-logs selectable">{run.logs.slice(-12).join('\n')}</pre>}
      {run.outputs.length > 0 && (
        <div className="fal-outputs">
          {run.outputs.map((o, i) => (
            <OutputCard key={i} o={o} targets={chainTargets(entries, o.kind)} onSave={() => onSave(i)} onChain={(t) => onChain(o, t)} />
          ))}
        </div>
      )}
      {run.status === 'completed' && !run.outputs.length && <div className="mute">FAL returned no files. The raw result is below.</div>}
      <details className="fal-json">
        <summary className="label">Input</summary>
        <pre className="file-pre selectable">{JSON.stringify(run.input, null, 2)}</pre>
      </details>
      {run.result !== undefined && (
        <details className="fal-json" open={run.status === 'completed' && !run.outputs.length}>
          <summary className="label">Result</summary>
          <pre className="file-pre selectable">{JSON.stringify(run.result, null, 2)}</pre>
        </details>
      )}
      {del && (
        <Confirm
          title="Delete this run?"
          tone="alert"
          confirmLabel="Delete"
          body="Removes it from history and deletes its downloaded files from Genio's data folder. Copies saved into worlds are kept."
          onConfirm={async () => {
            const r = await op('Delete run', () => api().falDelete(run.id))
            if (r?.ok) onDeleted()
          }}
          onClose={() => setDel(false)}
        />
      )}
    </div>
  )
}

const dirOf = (p: string): string => p.replace(/[\\/][^\\/]*$/, '')

function OutputCard({ o, targets, onSave, onChain }: { o: FalOutput; targets: FalCatalogueEntry[]; onSave: () => void; onChain: (t: FalCatalogueEntry) => void }) {
  const src = o.mediaUrl
  const isGlb = /\.glb$/i.test(o.fileName)
  const [menu, setMenu] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const away = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenu(false)
    }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [menu])
  return (
    <div className="fal-out">
      <div className={cx('fal-preview', o.kind)}>
        {o.kind === 'image' && (src || o.url) ? (
          <img src={src ?? o.url} alt={o.fileName} />
        ) : o.kind === 'audio' && src ? (
          <audio controls src={src} preload="metadata" />
        ) : o.kind === 'video' && src ? (
          <video controls src={src} preload="metadata" />
        ) : o.kind === 'model' && src && isGlb ? (
          <GlbViewer url={src} />
        ) : (
          <div className="fal-fileinfo mono">
            <div className="fal-ext">{o.fileName.split('.').pop()?.toUpperCase() ?? o.kind}</div>
            <div className="mute">{o.kind === 'model' ? '3D model · open it in your DCC tool or engine' : o.contentType ?? o.kind}</div>
          </div>
        )}
      </div>
      <div className="fal-out-meta">
        <div className="mono fal-out-name" title={o.localPath ?? o.url}>
          {o.fileName}
        </div>
        <div className="mute mono">
          {[o.kind, o.width && o.height ? `${o.width}×${o.height}` : '', bytes(o.size)].filter(Boolean).join(' · ')}
        </div>
        {o.downloadError && <div className="amber-text">Not downloaded: {o.downloadError}</div>}
      </div>
      <div className="row fal-out-actions">
        <button className="btn sm solid" onClick={onSave}>
          <Save size={12} /> Save to world
        </button>
        {targets.length > 0 && (
          <div className="fal-chain" ref={ref}>
            <button className={cx('btn sm', menu && 'on')} onClick={() => setMenu((m) => !m)} title="Feed this output to another model">
              Use as input <ArrowRight size={12} />
            </button>
            {menu && (
              <div className="fal-chain-menu panel glow">
                {targets.map((t) => (
                  <button
                    key={t.endpoint}
                    className="fal-chain-item"
                    onClick={() => {
                      setMenu(false)
                      onChain(t)
                    }}
                  >
                    <span className="fal-pick-ico">{KIND_ICON[t.output]}</span>
                    <span>{t.label}</span>
                    <span className="mute">{t.hint}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {o.localPath && (
          <>
            <button className="btn sm" onClick={() => void api().openPath(o.localPath!)} title="Open with the default app">
              Open
            </button>
            <button className="btn sm ghost icon" title="Show folder" onClick={() => void api().openPath(dirOf(o.localPath!))}>
              <FolderOpen size={12} />
            </button>
          </>
        )}
        {o.url && (
          <button
            className="btn sm ghost icon"
            title="Copy FAL URL (short-lived)"
            onClick={() => void navigator.clipboard.writeText(o.url).then(() => toast('success', 'URL copied'))}
          >
            <Copy size={12} />
          </button>
        )}
      </div>
    </div>
  )
}

function SaveToWorld({ run, index, activeWorld, onClose, onSaved }: { run: FalRun; index: number; activeWorld: string | null; onClose: () => void; onSaved: () => void }) {
  const projects = useStore((s) => s.snap.projects)
  const o = run.outputs[index]
  const [project, setProject] = useState(() => [run.world, activeWorld].find((w) => w && projects.some((p) => p.name === w)) ?? projects[0]?.name ?? '')
  const [folder, setFolder] = useState('')
  const [fileName, setFileName] = useState(o.fileName)
  const [busy, setBusy] = useState(false)
  const [exists, setExists] = useState<string | null>(null)
  const proj = projects.find((p) => p.name === project)

  // the world's save folder for this kind, else an engine-aware suggestion
  useEffect(() => {
    if (!project) return
    let live = true
    void api()
      .falWorld(project)
      .then((w) => live && setFolder(w.config.folders?.[o.kind] ?? suggestFolder(w.engine, o.kind, w.engineRoot)))
      .catch(() => live && setFolder(suggestFolder(proj?.engine, o.kind, proj?.engineRoot)))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, o.kind])

  const save = async (overwrite: boolean): Promise<void> => {
    setBusy(true)
    try {
      const r = await api().falSave({ runId: run.id, output: index, project, folder, fileName, overwrite })
      if (r.exists) {
        setExists(r.message)
        return
      }
      if (!r.ok) {
        toast('error', 'Save to world', r.message)
        return
      }
      toast('success', 'Saved to world', `${r.message}${r.provenance ? ` · provenance in ${r.provenance}` : ''} (not committed)`)
      for (const w of r.warnings ?? []) toast('warn', 'Git LFS', w)
      onSaved()
      onClose()
    } catch (e) {
      toast('error', 'Save to world', errText(e))
    } finally {
      setBusy(false)
    }
  }

  const browse = async (): Promise<void> => {
    try {
      const rel = await api().falPickFolder(project)
      if (rel !== null) setFolder(rel)
    } catch (e) {
      toast('error', 'Pick folder', errText(e))
    }
  }

  return (
    <Modal
      title="Save to world"
      kicker={o.fileName}
      onClose={onClose}
      width={540}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn solid" disabled={busy || !project || !fileName.trim()} onClick={() => void save(false)}>
            <Save size={13} /> Save
          </button>
        </>
      }
    >
      {projects.length === 0 ? (
        <div className="mute">No worlds registered yet. Add one in Worlds first.</div>
      ) : (
        <div className="form-grid">
          <Field label="World" wide>
            <select className="select" value={project} onChange={(e) => setProject(e.target.value)}>
              {projects.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Folder" hint={proj ? <span className="mono">{proj.path}</span> : undefined} wide>
            <div className="row">
              <input className="input mono" value={folder} placeholder="(world root)" spellCheck={false} onChange={(e) => setFolder(e.target.value)} />
              <button className="btn sm" onClick={() => void browse()} disabled={!project}>
                <FolderOpen size={12} /> Browse
              </button>
            </div>
          </Field>
          <Field label="File name" wide>
            <input className="input mono" value={fileName} spellCheck={false} onChange={(e) => setFileName(e.target.value)} />
          </Field>
          <div className="field-hint wide">
            Also writes <span className="mono">.genio/provenance/…</span> (how it was made) and a line in <span className="mono">.genio/spend.jsonl</span>. Nothing is committed: review and commit
            them with the asset.
          </div>
        </div>
      )}
      {exists && (
        <Confirm
          title="Replace the existing file?"
          tone="alert"
          confirmLabel="Overwrite"
          body={<>{exists} Overwrite it with this output?</>}
          onConfirm={() => save(true)}
          onClose={() => setExists(null)}
        />
      )}
    </Modal>
  )
}

function RecipeModal({
  world,
  endpoint,
  label,
  input,
  onClose,
  onSaved
}: {
  world: string | null
  endpoint: string
  label?: string
  input: Values
  onClose: () => void
  onSaved: (list: FalRecipe[], id: string) => void
}) {
  const [name, setName] = useState(label ? `${label} · ` : '')
  const [busy, setBusy] = useState(false)
  const files = Object.values(input).some((v) => (typeof v === 'string' && v.startsWith('@file:')) || (Array.isArray(v) && v.some((x) => typeof x === 'string' && x.startsWith('@file:'))))
  const save = async (): Promise<void> => {
    setBusy(true)
    const list = await op('Save recipe', () => api().falRecipeSave(world, { id: '', label: name.trim(), endpoint, input }))
    setBusy(false)
    if (!list) return
    const id = list.find((r) => r.label === name.trim())?.id ?? ''
    onSaved(list, id)
    toast('success', 'Recipe saved', world ? `${world}/.genio/fal/recipes.json (not committed)` : "Genio's data (Scratch)")
    onClose()
  }
  return (
    <Modal
      title="Save as recipe"
      kicker={world ?? 'Scratch'}
      onClose={onClose}
      width={480}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn solid" disabled={busy || !name.trim()} onClick={() => void save()}>
            <Star size={13} /> Save recipe
          </button>
        </>
      }
    >
      <Field label="Name" hint="Recipes sit on top of the model picker. In a world they live in .genio/fal/recipes.json, so units can use them too.">
        <input
          className="input"
          autoFocus
          value={name}
          placeholder="UI icon, Ambience loop, Prop → low-poly…"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && name.trim() && void save()}
        />
      </Field>
      <div className="field-hint mono" style={{ marginTop: 10 }}>
        {endpoint} · {Object.keys(input).length} parameter{Object.keys(input).length === 1 ? '' : 's'}
        {files && <span className="amber-text"> · local files are not kept in recipes</span>}
      </div>
    </Modal>
  )
}

const KINDS: FalOutputKind[] = ['image', 'audio', 'model', 'video']

function WorldSettings({ world, state, onClose, onSaved }: { world: string | null; state: FalWorldState | null; onClose: () => void; onSaved: (s: FalWorldState) => void }) {
  const cfg = state?.config ?? {}
  const [folders, setFolders] = useState<Partial<Record<FalOutputKind, string>>>(cfg.folders ?? {})
  const [cap, setCap] = useState(cfg.budget?.monthly_usd !== undefined ? String(cfg.budget.monthly_usd) : '')
  const [over, setOver] = useState(cfg.budget?.confirm_over_usd !== undefined ? String(cfg.budget.confirm_over_usd) : '')
  const [busy, setBusy] = useState(false)
  const numOrUndef = (s: string): number | undefined => (s.trim() && Number.isFinite(Number(s)) && Number(s) >= 0 ? Number(s) : undefined)
  const bad = (cap.trim() && numOrUndef(cap) === undefined) || (over.trim() && numOrUndef(over) === undefined)
  const save = async (): Promise<void> => {
    setBusy(true)
    const next: FalWorldConfig = { ...cfg, folders, budget: { monthly_usd: numOrUndef(cap), confirm_over_usd: numOrUndef(over) } }
    const s = await op('FAL settings', () => api().falWorldConfig(world, next), () => (world ? `${world}/.genio/fal/config.json saved (not committed)` : 'Saved'))
    setBusy(false)
    if (s) {
      onSaved(s)
      onClose()
    }
  }
  return (
    <Modal
      title={`FAL settings · ${world ?? 'Scratch'}`}
      kicker={world ? '.genio/fal/config.json' : "Genio's data"}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn solid" disabled={busy || !!bad} onClick={() => void save()}>
            <Save size={13} /> Save settings
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Monthly budget (USD)" hint="Estimated spend this month; runs above it ask first.">
          <input className="input mono" value={cap} placeholder="no cap" onChange={(e) => setCap(e.target.value)} />
        </Field>
        <Field label="Confirm runs over (USD)" hint="A single run estimated above this asks first.">
          <input className="input mono" value={over} placeholder="never ask" onChange={(e) => setOver(e.target.value)} />
        </Field>
        {world &&
          KINDS.map((k) => (
            <Field key={k} label={`${KIND_LABEL[k]} folder`} wide>
              <input
                className="input mono"
                value={folders[k] ?? ''}
                placeholder={suggestFolder(state?.engine, k, state?.engineRoot)}
                spellCheck={false}
                onChange={(e) => setFolders((f) => ({ ...f, [k]: e.target.value }))}
              />
            </Field>
          ))}
      </div>
      <div className="field-hint" style={{ marginTop: 12 }}>
        {world
          ? 'Saved inside the world so units follow the same folders and budget. Genio never commits it; units get a hard stop at their own budget.'
          : 'Scratch runs belong to no world; these settings stay in Genio’s data.'}
      </div>
    </Modal>
  )
}
