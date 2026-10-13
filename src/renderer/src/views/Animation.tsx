import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Ban, Bone, Download, FolderOpen, KeyRound, PersonStanding, Play, RefreshCw, RotateCcw, Save, Settings2, Trash, Upload, UserRound, Video } from 'lucide-react'
import { budgetCheck, fmtUsd } from '@shared/fal'
import {
  UTHANA_BUILTINS, UTHANA_DEFAULTS, UTHANA_DEFAULT_CHARACTER, UTHANA_FORMATS, UTHANA_FPS, UTHANA_MODELS, UTHANA_RERIG_TARGETS, accountLine, estimateUthana, exportFileName,
  exportProblems, exportWarnings, filterUthanaRuns, runCost, textParamErrors, textParamsFor, uthanaModel, type UthanaAccount, type UthanaCharacterRecord, type UthanaExportOptions,
  type UthanaFile, type UthanaFileInfo, type UthanaFormat, type UthanaRemoteCharacter, type UthanaRun, type UthanaScope, type UthanaTextParams, type UthanaWorldState
} from '@shared/uthana'
import { api, errText, go, op, toast, useStore } from '../store'
import { Chip, Confirm, Empty, Field, Modal, Toggle, ViewHeader, useNow } from '../components/ui'
import { GlbViewer } from '../components/GlbViewer'
import { requestSystemsSection } from './Systems'
import { FAL_STATUS, bytes, load, store } from '../lib/fal'
import { ago, cx } from '../lib/format'

type Source = 'text' | 'video'

interface Draft {
  source: Source
  textModel: string
  videoModel: string
  text: UthanaTextParams
  video?: UthanaFileInfo
  motionName: string
}

const WORLD_KEY = 'genio.anim.world'
const SCRATCH = '~scratch'
const charKey = (world: string | null): string => `genio.anim.char:${world ?? SCRATCH}`

// survive view switches (the stage remounts each view)
let keptDraft: Draft = { source: 'text', textModel: 'text-to-motion-3.0', videoModel: 'video-to-motion-2.0', text: { prompt: '' }, motionName: '' }
let keptSelected: string | null = null
let keptScope: UthanaScope = 'world'
let keptAccount: UthanaAccount | null = null

const upsert = (list: UthanaRun[], r: UthanaRun): UthanaRun[] => (list.some((x) => x.id === r.id) ? list.map((x) => (x.id === r.id ? r : x)) : [r, ...list])

const openAccounts = (): void => {
  requestSystemsSection('accounts')
  go('systems')
}

function duration(from?: string, to?: string, now = Date.now()): string {
  if (!from) return ''
  const s = Math.max(0, Math.round(((to ? new Date(to).getTime() : now) - new Date(from).getTime()) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

/** The text a run is shown by in history rows. */
function runTitle(r: UthanaRun): string {
  if (r.kind === 'character') return `Character: ${r.characterName ?? r.input.name ?? 'upload'}`
  if (typeof r.input.prompt === 'string' && r.input.prompt) return r.input.prompt
  return r.motionName ?? (typeof r.input.motion_name === 'string' ? r.input.motion_name : '(video)')
}

const costText = (r: UthanaRun): string | undefined => {
  const c = runCost(r)
  if (c === undefined) return undefined
  if (r.kind !== 'character' && r.outputSeconds !== undefined) return `${fmtUsd(c)} (${r.outputSeconds.toFixed(1)} s)`
  return `${r.estUpTo ? '≤ ' : '≈ '}${fmtUsd(c)}`
}

export function Animation() {
  const projects = useStore((s) => s.snap.projects)
  const [runs, setRuns] = useState<UthanaRun[] | null>(null)
  const [selected, setSelected] = useState<string | null>(keptSelected)
  const [scope, setScopeState] = useState<UthanaScope>(keptScope)
  const [worldSel, setWorldSel] = useState<string | null | undefined>(() => load<string | undefined>(WORLD_KEY, undefined))
  const [wstate, setWstate] = useState<UthanaWorldState | null>(null)
  const [draft, setDraftState] = useState<Draft>(keptDraft)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<{ reasons: string[]; run: () => Promise<void> } | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [account, setAccount] = useState<UthanaAccount | null>(keptAccount)
  const [accountErr, setAccountErr] = useState<string | null>(null)
  const [remote, setRemote] = useState<UthanaRemoteCharacter[] | null>(null)
  const [over, setOver] = useState(false)

  const world: string | null =
    worldSel === undefined ? projects[0]?.name ?? null : worldSel && worldSel !== SCRATCH && projects.some((p) => p.name === worldSel) ? worldSel : null
  const worldLabel = world ?? 'Scratch'
  const setWorld = (w: string | null): void => {
    setWorldSel(w ?? SCRATCH)
    store(WORLD_KEY, w ?? SCRATCH)
  }
  const setScope = (s: UthanaScope): void => {
    keptScope = s
    setScopeState(s)
  }
  const setDraft = (patch: Partial<Draft>): void => setDraftState((d) => (keptDraft = { ...d, ...patch }))
  const setText = (patch: Partial<UthanaTextParams>): void => {
    setDraftState((d) => (keptDraft = { ...d, text: { ...d.text, ...patch } }))
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !(k in patch))))
  }

  const [charId, setCharIdState] = useState<string>(() => load(charKey(world), UTHANA_DEFAULT_CHARACTER.id))
  useEffect(() => setCharIdState(load(charKey(world), UTHANA_DEFAULT_CHARACTER.id)), [world])
  const setCharId = (id: string): void => {
    setCharIdState(id)
    store(charKey(world), id)
  }

  const loadWorld = (): void => {
    void api()
      .uthanaWorld(world)
      .then(setWstate)
      .catch((e) => toast('error', 'Animation', errText(e)))
  }
  const loadAccount = (): void => {
    setAccountErr(null)
    void api()
      .uthanaAccount()
      .then((a) => {
        keptAccount = a
        setAccount(a)
      })
      .catch((e) => setAccountErr(errText(e)))
  }

  useEffect(() => {
    void api()
      .uthanaRuns()
      .then(setRuns)
      .catch((e) => {
        toast('error', 'Animation history', errText(e))
        setRuns([])
      })
  }, [])

  useEffect(() => {
    loadWorld()
    return window.genio.on((ev) => {
      if (ev.type !== 'uthana-run') return
      setRuns((rs) => upsert(rs ?? [], ev.run))
      if (!FAL_STATUS[ev.run.status].live) loadWorld()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world])

  // account figures are free queries: read them once a session when a key is set
  useEffect(() => {
    if (wstate?.keySet && !keptAccount) loadAccount()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wstate?.keySet])

  useEffect(() => {
    keptSelected = selected
  }, [selected])

  const shown = useMemo(() => filterUthanaRuns(runs ?? [], world, scope), [runs, world, scope])
  const run = shown.find((r) => r.id === selected) ?? shown[0]
  const budget = wstate?.world === world ? wstate : null
  const noKey = wstate ? !wstate.keySet : false

  const characters = useMemo(() => {
    const list: { id: string; name: string; group: string }[] = UTHANA_BUILTINS.map((b) => ({ ...b, group: 'Uthana stock' }))
    for (const c of budget?.characters ?? []) list.push({ id: c.id, name: c.name, group: `Uploaded in ${worldLabel}` })
    for (const c of remote ?? []) if (!list.some((x) => x.id === c.id)) list.push({ id: c.id, name: c.name, group: 'Your Uthana account' })
    if (!list.some((x) => x.id === charId)) list.push({ id: charId, name: charId, group: 'Other' })
    return list
  }, [budget?.characters, remote, charId, worldLabel])
  const charName = characters.find((c) => c.id === charId)?.name

  const model = draft.source === 'text' ? draft.textModel : draft.videoModel
  const est = draft.source === 'text' ? estimateUthana(model, { length: draft.text.length }) : estimateUthana(model, { seconds: draft.video?.seconds })

  const confirmPaid = (estUsd: number | undefined, start: () => Promise<void>): void => {
    const check = budgetCheck(budget?.spentUsd ?? 0, estUsd, budget?.budget, worldLabel)
    if (check.confirm) setConfirm({ reasons: check.reasons, run: start })
    else void start()
  }

  const submit = (): void => {
    if (busy) return
    if (draft.source === 'text') {
      const errs = textParamErrors(model, textParamsFor(model, draft.text))
      setErrors(errs)
      if (Object.keys(errs).length) return
    } else if (!draft.video) {
      setErrors({ video: 'Pick a video.' })
      return
    }
    confirmPaid(est.usd, async () => {
      setBusy(true)
      const r = await op('Animation', () =>
        api().uthanaGenerate({
          world: world ?? undefined,
          model,
          characterId: charId,
          characterName: charName,
          ...(draft.source === 'text' ? { text: textParamsFor(model, draft.text) } : { video: { path: draft.video!.path, motionName: draft.motionName } })
        })
      )
      setBusy(false)
      if (!r) return
      setRuns((rs) => upsert(rs ?? [], r))
      if (scope === 'world' && (r.world ?? null) !== world) setScope('all')
      setSelected(r.id)
      loadWorld()
    })
  }

  const reuse = (r: UthanaRun): void => {
    setErrors({})
    if (r.characterId) setCharId(r.characterId)
    if (r.kind === 'text') {
      const { prompt, foot_ik, length, steps, cfg_scale, seed, retargeting_ik, rewrite_prompt, fast } = r.input as unknown as Partial<UthanaTextParams>
      setDraft({ source: 'text', textModel: r.model, text: { prompt: prompt ?? '', foot_ik, length, steps, cfg_scale, seed, retargeting_ik, rewrite_prompt, fast } })
    } else if (r.kind === 'video' && typeof r.input.video === 'string') {
      const p = r.input.video.replace(/^@file:/, '')
      setDraft({ source: 'video', videoModel: r.model, motionName: String(r.input.motion_name ?? '') })
      void api()
        .uthanaInspect(p, 'video', world)
        .then((v) => setDraft({ video: v }))
        .catch((e) => toast('warn', 'Video', errText(e)))
    }
  }

  const pickVideo = async (inWorld: boolean): Promise<void> => {
    try {
      const v = await api().uthanaPickFile(inWorld ? world : null, 'video')
      if (v) {
        setDraft({ video: v, motionName: draft.motionName || v.name.replace(/\.[^.]+$/, '') })
        setErrors({})
      }
    } catch (e) {
      toast('error', 'Video', errText(e))
    }
  }
  const dropVideo = (e: DragEvent): void => {
    e.preventDefault()
    setOver(false)
    const f = e.dataTransfer.files[0]
    const p = f ? window.genio.pathForFile(f) : ''
    if (!p) return
    void api()
      .uthanaInspect(p, 'video', world)
      .then((v) => {
        setDraft({ video: v, motionName: draft.motionName || v.name.replace(/\.[^.]+$/, '') })
        setErrors({})
      })
      .catch((err) => toast('error', 'Video', errText(err)))
  }

  const cap = budget?.budget?.monthly_usd
  const m = uthanaModel(model)
  const defs = UTHANA_DEFAULTS[model] ?? {}
  const numVal = (v: string): number | undefined => (v.trim() === '' || !Number.isFinite(Number(v)) ? undefined : Number(v))

  return (
    <div className="view">
      <ViewHeader
        kicker="3D character animation · Uthana"
        title={
          <>
            <span className="accent">Anim</span>ation
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
            <span className={cx('fal-spend mono', cap !== undefined && budget.spentUsd >= cap && 'amber-text')} title={`Estimated spend in ${worldLabel} this month (${budget.month}), FAL and Animation together`}>
              {fmtUsd(budget.spentUsd)}
              {cap !== undefined && <span className="mute"> / {fmtUsd(cap)}</span>}
              <span className="mute"> this month</span>
            </span>
          )}
          <button className="btn sm ghost icon" title={`Animation settings for ${worldLabel}: save folder`} onClick={() => setSettingsOpen(true)}>
            <Settings2 size={13} />
          </button>
        </div>
        {wstate?.keySet && (
          <button className="btn sm ghost" onClick={loadAccount} title={account ? `Uthana account${account.org ? ` · ${account.org}` : ''}, checked ${ago(account.checkedAt)}. Click to refresh.` : 'Read the account (free query)'}>
            <KeyRound size={12} /> {accountErr ? <span className="alert-text">account: {accountErr}</span> : account ? accountLine(account) : 'key set'}
          </button>
        )}
      </ViewHeader>
      <div className="fal-layout">
        <div className="fal-side">
          {noKey ? (
            <section className="panel fal-compose">
              <Empty icon={<KeyRound size={34} className="amber-text" />} title="No Uthana key">
                Genio calls Uthana from its core with a key kept encrypted in your base; it never reaches this screen. Get one at uthana.com/app/account.
                <div style={{ marginTop: 14 }}>
                  <button className="btn solid" onClick={openAccounts}>
                    Set it in Systems → Accounts
                  </button>
                </div>
              </Empty>
            </section>
          ) : (
            <section className="panel fal-compose">
              <div className="anim-char">
                <span className="label">Character</span>
                <div className="row">
                  <select className="select" value={charId} onChange={(e) => setCharId(e.target.value)}>
                    {[...new Set(characters.map((c) => c.group))].map((g) => (
                      <optgroup key={g} label={g}>
                        {characters
                          .filter((c) => c.group === g)
                          .map((c) => (
                            <option key={`${g}-${c.id}`} value={c.id}>
                              {c.name}
                              {c.id === UTHANA_DEFAULT_CHARACTER.id ? ' (default)' : ''}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                  <button className="btn sm" title="Upload an FBX / GLB / glTF character (from disk or this world)" onClick={() => setUploadOpen(true)}>
                    <Upload size={12} /> Upload
                  </button>
                  <button
                    className="btn sm ghost icon"
                    title="List the characters in your Uthana account (free query)"
                    onClick={() =>
                      void op('Uthana characters', () => api().uthanaCharacters()).then((l) => {
                        if (l) {
                          setRemote(l)
                          toast('success', 'Uthana characters', `${l.length} in your account`)
                        }
                      })
                    }
                  >
                    <RefreshCw size={12} />
                  </button>
                </div>
                <div className="fal-hint mute">Motions are retargeted to this character when they are previewed and downloaded.</div>
              </div>

              <div className="fal-params-head">
                <span className="label">Motion from</span>
                <div className="fal-seg">
                  <button className={cx('fal-seg-opt', draft.source === 'text' && 'on')} onClick={() => setDraft({ source: 'text' })}>
                    Text
                  </button>
                  <button className={cx('fal-seg-opt', draft.source === 'video' && 'on')} onClick={() => setDraft({ source: 'video' })}>
                    Video
                  </button>
                </div>
              </div>
              <div className="fal-seg wrap">
                {UTHANA_MODELS.filter((x) => x.kind === draft.source).map((x) => (
                  <button
                    key={x.id}
                    className={cx('fal-seg-opt', model === x.id && 'on')}
                    title={x.hint}
                    onClick={() => {
                      setErrors({})
                      setDraft(draft.source === 'text' ? { textModel: x.id } : { videoModel: x.id })
                    }}
                  >
                    {x.label.replace(/^(Text|Video) to motion /, '')}
                  </button>
                ))}
              </div>
              {m && <div className="fal-hint mute">{m.hint}</div>}

              {draft.source === 'text' ? (
                <div className="fal-form">
                  <div className={cx('fal-field', errors.prompt && 'bad')}>
                    <div className="fal-field-head">
                      <span className="fal-field-title">Prompt</span>
                    </div>
                    <textarea
                      className="textarea"
                      rows={3}
                      value={draft.text.prompt}
                      placeholder="a person walks forward, stops and waves"
                      onChange={(e) => setText({ prompt: e.target.value })}
                      onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && submit()}
                    />
                    {errors.prompt && <span className="alert-text fal-field-err">{errors.prompt}</span>}
                  </div>
                  {model !== 'text-to-motion' && (
                    <NumField
                      label="Length (s)"
                      hint={model === 'text-to-motion-3.0' ? 'whole seconds, 4-10' : '0.25-10'}
                      value={draft.text.length}
                      placeholder={String(defs.length)}
                      error={errors.length}
                      onChange={(v) => setText({ length: numVal(v) })}
                    />
                  )}
                  {model === 'text-to-motion-bucmd' && (
                    <>
                      <NumField label="Steps" hint="1-150" value={draft.text.steps} placeholder={String(defs.steps)} error={errors.steps} onChange={(v) => setText({ steps: numVal(v) })} />
                      <NumField label="Guidance (cfg)" hint="0-10" value={draft.text.cfg_scale} placeholder={String(defs.cfg_scale)} error={errors.cfg_scale} onChange={(v) => setText({ cfg_scale: numVal(v) })} />
                      <NumField label="Seed" hint="1-99999, empty = random" value={draft.text.seed} placeholder="random" error={errors.seed} onChange={(v) => setText({ seed: numVal(v) })} />
                      <Toggle checked={draft.text.retargeting_ik ?? true} onChange={(v) => setText({ retargeting_ik: v })} label="Retargeting IK (recommended)" />
                    </>
                  )}
                  {model !== 'text-to-motion-3.0' && <Toggle checked={draft.text.foot_ik ?? false} onChange={(v) => setText({ foot_ik: v })} label="Foot IK (better contact on uneven ground)" />}
                  {model === 'text-to-motion-3.0' && (
                    <>
                      <Toggle checked={draft.text.rewrite_prompt ?? true} onChange={(v) => setText({ rewrite_prompt: v })} label="Rewrite the prompt into physical motion direction" />
                      <Toggle checked={draft.text.fast ?? false} onChange={(v) => setText({ fast: v })} label="Fast variant" />
                    </>
                  )}
                </div>
              ) : (
                <div className="fal-form">
                  <div
                    className={cx('fal-file', over && 'over', errors.video && 'bad')}
                    onDragOver={(e) => {
                      e.preventDefault()
                      setOver(true)
                    }}
                    onDragLeave={() => setOver(false)}
                    onDrop={dropVideo}
                  >
                    {draft.video ? (
                      <div className="mono anim-file">
                        <Video size={14} /> {draft.video.inWorld ?? draft.video.name} · {bytes(draft.video.bytes)}
                        {draft.video.seconds !== undefined && ` · ${draft.video.seconds.toFixed(1)} s`}
                      </div>
                    ) : (
                      <div className="mute">Drop a video here (.mp4, .mov, .avi), 2-60 s of one person, whole body in frame.</div>
                    )}
                    <div className="fal-file-actions">
                      {world && (
                        <button className="btn sm" onClick={() => void pickVideo(true)}>
                          <FolderOpen size={12} /> From {world}
                        </button>
                      )}
                      <button className="btn sm" onClick={() => void pickVideo(false)}>
                        <FolderOpen size={12} /> From disk
                      </button>
                    </div>
                  </div>
                  {errors.video && <span className="alert-text fal-field-err">{errors.video}</span>}
                  {draft.video?.seconds !== undefined && (draft.video.seconds < 2 || draft.video.seconds > 60) && (
                    <div className="amber-text fal-hint">Uthana takes videos of 2-60 s; this one is {draft.video.seconds.toFixed(1)} s.</div>
                  )}
                  <div className="fal-field">
                    <div className="fal-field-head">
                      <span className="fal-field-title">Motion name</span>
                    </div>
                    <input className="input" value={draft.motionName} placeholder="the video's name" onChange={(e) => setDraft({ motionName: e.target.value })} />
                  </div>
                </div>
              )}

              <div className="fal-run-row">
                <div className="fal-cost" title={`Uthana's published rates (uthana.com/pricing), checked 2026-10-13. Billed per generated second; downloads are free on pay-as-you-go.`}>
                  <span className="label">Cost</span>
                  <span className="mono">{est.text}</span>
                </div>
                <button className="btn solid" disabled={busy || !wstate} onClick={submit} title="Generate (Ctrl+Enter)">
                  <Play size={13} /> Generate
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
            {runs && shown.length === 0 && <div className="mute side-empty">{scope === 'world' ? `No animations in ${worldLabel} yet.` : 'No animations yet.'}</div>}
            <div className="fal-history-list">
              {shown.map((r) => (
                <HistoryRow key={r.id} r={r} on={r.id === run?.id} showWorld={scope === 'all'} onClick={() => setSelected(r.id)} />
              ))}
            </div>
          </section>
        </div>
        <section className="panel fal-detail">
          {run ? (
            <RunDetail
              key={run.id}
              run={run}
              world={world}
              folder={budget?.folder}
              onReuse={() => reuse(run)}
              onUseCharacter={(id) => setCharId(id)}
              onDeleted={() => setSelected(null)}
              onSaved={loadWorld}
            />
          ) : (
            <Empty icon={<PersonStanding size={34} className="neon-text" />} title="No animation yet">
              Pick a character, describe a motion (or drop a video) and generate. The result plays here and stays in Genio's data folder until you export it or save it to a world.
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
              <p className="mute">The budget is the world's FAL budget (it covers Animation too). It warns and asks; it never blocks you.</p>
            </>
          }
          onConfirm={() => confirm.run()}
          onClose={() => setConfirm(null)}
        />
      )}
      {uploadOpen && (
        <UploadModal
          world={world}
          onClose={() => setUploadOpen(false)}
          confirmPaid={confirmPaid}
          onStarted={(r) => {
            setRuns((rs) => upsert(rs ?? [], r))
            setSelected(r.id)
          }}
        />
      )}
      {settingsOpen && <WorldSettings world={world} state={budget} onClose={() => setSettingsOpen(false)} onSaved={setWstate} />}
    </div>
  )
}

function NumField({ label, hint, value, placeholder, error, onChange }: { label: string; hint: string; value?: number; placeholder?: string; error?: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value === undefined ? '' : String(value))
  useEffect(() => {
    if (value === undefined ? text.trim() !== '' && Number.isFinite(Number(text)) : Number(text) !== value) setText(value === undefined ? '' : String(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  return (
    <div className={cx('fal-field', error && 'bad')}>
      <div className="fal-field-head">
        <span className="fal-field-title">{label}</span>
        <span className="fal-field-aside mute">{hint}</span>
      </div>
      <input
        className="input mono fal-num"
        value={text}
        placeholder={placeholder}
        inputMode="decimal"
        onChange={(e) => {
          setText(e.target.value)
          onChange(e.target.value)
        }}
      />
      {error && <span className="alert-text fal-field-err">{error}</span>}
    </div>
  )
}

function HistoryRow({ r, on, showWorld, onClick }: { r: UthanaRun; on: boolean; showWorld: boolean; onClick: () => void }) {
  const st = FAL_STATUS[r.status]
  return (
    <button className={cx('fal-hrow', on && 'on')} onClick={onClick}>
      <div className="fal-thumb">{r.kind === 'character' ? <UserRound size={16} /> : r.kind === 'video' ? <Video size={16} /> : <PersonStanding size={16} />}</div>
      <div className="fal-hmain">
        <div className="fal-hprompt">{runTitle(r)}</div>
        <div className="mono mute fal-hmeta">
          {showWorld && <>{r.world ?? 'scratch'} · </>}
          {uthanaModel(r.model)?.label ?? r.model} · {ago(r.createdAt)}
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
  world,
  folder,
  onReuse,
  onUseCharacter,
  onDeleted,
  onSaved
}: {
  run: UthanaRun
  world: string | null
  folder?: string
  onReuse: () => void
  onUseCharacter: (id: string) => void
  onDeleted: () => void
  onSaved: () => void
}) {
  const st = FAL_STATUS[run.status]
  const now = useNow(st.live ? 1000 : 60_000)
  const [del, setDel] = useState(false)
  const [motionId, setMotionId] = useState<string | undefined>(run.motionId)
  const [source, setSource] = useState<'skeleton' | 'mesh'>('mesh')
  const [preview, setPreview] = useState<UthanaFile | null>(null)
  const [loading, setLoading] = useState(false)
  const [previewErr, setPreviewErr] = useState<string | null>(null)
  const cost = costText(run)
  const mid = motionId ?? run.motionId

  // show what is already downloaded for the chosen source; fetch the character GLB only on request
  useEffect(() => {
    setPreviewErr(null)
    const have = run.files.find((f) => f.preview === source && f.motionId === mid)
    setPreview(have ?? null)
  }, [run.files, source, mid])

  const loadPreview = async (): Promise<void> => {
    setLoading(true)
    setPreviewErr(null)
    try {
      setPreview(await api().uthanaPreview({ runId: run.id, motionId: mid, source }))
    } catch (e) {
      setPreviewErr(errText(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    if (run.status === 'completed' && run.kind !== 'character' && source === 'mesh' && !run.files.some((f) => f.preview === 'mesh' && f.motionId === mid)) void loadPreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.status, mid, source])

  const elapsed = run.startedAt ? (now - new Date(run.startedAt).getTime()) / 1000 : 0
  const pct = run.estProcessingSecs ? Math.min(95, (elapsed / run.estProcessingSecs) * 100) : undefined

  return (
    <div className="fal-run">
      <div className="fal-run-head">
        <div className="fal-run-title">
          <div className="anim-title">{runTitle(run)}</div>
          <div className="mute fal-run-meta">
            {uthanaModel(run.model)?.label ?? run.model} · {run.world ?? 'Scratch'} · {new Date(run.createdAt).toLocaleString()} · {duration(run.createdAt, run.completedAt, now)}
            {cost && <> · {cost}</>}
            {run.kind !== 'character' && <> · on {run.characterName ?? run.characterId}</>}
            {mid && (
              <>
                {' '}
                · <span className="mono selectable">{mid}</span>
              </>
            )}
          </div>
        </div>
        <Chip tone={st.tone} pulse={st.live}>
          {st.label}
          {st.live && run.jobStatus ? ` · ${run.jobStatus.toLowerCase()}` : ''}
        </Chip>
        <div className="row">
          {st.live && (
            <button className="btn sm alert" title="Uthana has no cancel: this only stops Genio waiting" onClick={() => void op('Stop waiting', () => api().uthanaCancel(run.id))}>
              <Ban size={12} /> Stop waiting
            </button>
          )}
          {run.kind !== 'character' && (
            <button className="btn sm" onClick={onReuse} title="Load this run's model and inputs into the form">
              <RotateCcw size={12} /> Reuse inputs
            </button>
          )}
          {!st.live && (
            <button className="btn sm ghost icon alert" title="Delete run and its downloads" onClick={() => setDel(true)}>
              <Trash size={12} />
            </button>
          )}
        </div>
      </div>
      {st.live && (
        <>
          <div className={cx('bar', pct === undefined && 'indeterminate')} style={{ ['--c' as string]: `var(--${st.tone})` }}>
            <i style={pct !== undefined ? { width: `${pct}%` } : undefined} />
          </div>
          <div className="mute fal-hint">
            {run.kind === 'character'
              ? 'Uploading; auto-rigging takes 30-60 s (Uthana gives up after 5 minutes).'
              : run.jobId
                ? `Job ${run.jobId}${run.estProcessingSecs ? ` · Uthana estimates ~${Math.round(run.estProcessingSecs)} s` : ''} · polled every 5 s. Leaving this screen or closing Genio does not lose it.`
                : 'Waiting for Uthana…'}
          </div>
        </>
      )}
      {run.error && <pre className={cx('refusal selectable', run.status === 'cancelled' && 'mute')}>{run.error}</pre>}

      {run.kind === 'character' && run.character && (
        <div className="anim-character panel">
          <div>
            <div className="anim-title">{run.character.name}</div>
            <div className="mono mute selectable">{run.character.id}</div>
            {run.character.autoRigConfidence !== undefined && (
              <div className={cx(run.character.autoRigConfidence < 0.6 && 'amber-text')}>
                Auto-rig confidence {(run.character.autoRigConfidence * 100).toFixed(0)}%{run.character.autoRigConfidence < 0.6 ? ': check the result before using it' : ''}
              </div>
            )}
            {run.character.message && <div className="mute">{run.character.message}</div>}
            {run.character.source && <div className="mute mono">from {run.character.source}</div>}
          </div>
          <button className="btn sm solid" onClick={() => onUseCharacter(run.character!.id)}>
            <UserRound size={12} /> Use this character
          </button>
        </div>
      )}

      {run.status === 'completed' && run.kind !== 'character' && mid && (
        <>
          <div className="anim-preview-head">
            <div className="fal-seg small">
              <button className={cx('fal-seg-opt', source === 'mesh' && 'on')} onClick={() => setSource('mesh')} title="GLB with the character (counts as a download on legacy subscriptions)">
                <PersonStanding size={11} /> Character
              </button>
              <button className={cx('fal-seg-opt', source === 'skeleton' && 'on')} onClick={() => setSource('skeleton')} title="Motion-only GLB: never counts against a download quota">
                <Bone size={11} /> Skeleton
              </button>
            </div>
            {(run.motionIds?.length ?? 0) > 1 && (
              <select className="select compact" value={mid} onChange={(e) => setMotionId(e.target.value)} title="This run returned several motions">
                {run.motionIds!.map((id, i) => (
                  <option key={id} value={id}>
                    Motion {i + 1} · {id}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="fal-preview model anim-stage">
            {preview ? (
              <GlbViewer key={preview.mediaUrl} url={preview.mediaUrl} className="anim-viewer" />
            ) : loading ? (
              <div className="mute">Downloading the preview…</div>
            ) : (
              <div className="fal-fileinfo">
                {previewErr && <div className="alert-text">{previewErr}</div>}
                <button className="btn sm" onClick={() => void loadPreview()}>
                  <Download size={12} /> Load preview
                </button>
              </div>
            )}
          </div>
          <ExportPanel run={run} motionId={mid} world={world} folder={folder} onSaved={onSaved} />
        </>
      )}

      <details className="fal-json">
        <summary className="label">Input</summary>
        <pre className="file-pre selectable">{JSON.stringify(run.input, null, 2)}</pre>
      </details>
      {run.result !== undefined && (
        <details className="fal-json">
          <summary className="label">Result</summary>
          <pre className="file-pre selectable">{JSON.stringify(run.result, null, 2)}</pre>
        </details>
      )}
      {del && (
        <Confirm
          title="Delete this run?"
          tone="alert"
          confirmLabel="Delete"
          body="Removes it from history and deletes its downloads from Genio's data folder. Uthana keeps the motion in your account; copies saved into worlds are kept."
          onConfirm={async () => {
            const r = await op('Delete run', () => api().uthanaDelete(run.id))
            if (r?.ok) onDeleted()
          }}
          onClose={() => setDel(false)}
        />
      )}
    </div>
  )
}

const EXPORT_KEY = 'genio.anim.export'

function ExportPanel({ run, motionId, world, folder, onSaved }: { run: UthanaRun; motionId: string; world: string | null; folder?: string; onSaved: () => void }) {
  const projects = useStore((s) => s.snap.projects)
  const saved = load<{ format: UthanaFormat; options: UthanaExportOptions }>(EXPORT_KEY, { format: 'fbx', options: { fps: 30 } })
  const [format, setFormat] = useState<UthanaFormat>(saved.format)
  const [options, setOptions] = useState<UthanaExportOptions>(saved.options)
  const name = exportFileName(run.motionName ?? (typeof run.input.prompt === 'string' ? run.input.prompt : undefined), format, options)
  const [fileName, setFileName] = useState(name)
  const touched = useRef(false)
  const [busy, setBusy] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  useEffect(() => {
    if (!touched.current) setFileName(name)
  }, [name])
  useEffect(() => store(EXPORT_KEY, { format, options }), [format, options])

  const set = (patch: Partial<UthanaExportOptions>): void => setOptions((o) => Object.fromEntries(Object.entries({ ...o, ...patch }).filter(([, v]) => v !== undefined && v !== false)) as UthanaExportOptions)
  const problems = exportProblems(format, options)
  const warnings = exportWarnings(format, options, run.characterId)
  const req = { runId: run.id, motionId, format, options, fileName }

  const exportFile = async (): Promise<void> => {
    setBusy(true)
    const r = await op('Export', () => api().uthanaExport({ ...req, dest: 'file' }))
    setBusy(false)
    if (r?.ok) toast('success', 'Exported', r.path)
  }

  return (
    <div className="anim-export">
      <div className="fal-params-head">
        <span className="label">Export</span>
        <div className="fal-seg">
          {UTHANA_FORMATS.map((f) => (
            <button
              key={f}
              className={cx('fal-seg-opt', format === f && 'on')}
              onClick={() => {
                setFormat(f)
                // options only one format takes are dropped when switching away from it
                if (f !== 'fbx') set({ robloxCompatible: undefined })
                if (f !== 'glb' && options.noMesh === 'minimal') set({ noMesh: undefined })
              }}
            >
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <div className="anim-export-grid">
        <label className="anim-opt">
          <span className="fal-field-title">FPS</span>
          <select className="select compact" value={options.fps ?? ''} onChange={(e) => set({ fps: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">Uthana default</option>
            {UTHANA_FPS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="anim-opt">
          <span className="fal-field-title">Speed</span>
          <select className="select compact" value={options.speed ?? 1} onChange={(e) => set({ speed: Number(e.target.value) === 1 ? undefined : Number(e.target.value) })}>
            {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        <label className="anim-opt">
          <span className="fal-field-title">Mesh</span>
          <select
            className="select compact"
            value={options.noMesh === 'minimal' ? 'minimal' : options.noMesh ? 'none' : 'with'}
            onChange={(e) => set({ noMesh: e.target.value === 'minimal' ? 'minimal' : e.target.value === 'none' ? true : undefined })}
          >
            <option value="with">With character</option>
            <option value="none">Animation only</option>
            {format === 'glb' && <option value="minimal">Minimal skeleton mesh</option>}
          </select>
        </label>
        <Toggle checked={!!options.inPlace} onChange={(v) => set({ inPlace: v })} label="In place (no root travel)" />
        <Toggle checked={!!options.torsoOnly} onChange={(v) => set({ torsoOnly: v })} label="Torso only (still legs)" />
        <Toggle checked={!!options.robloxCompatible} disabled={format !== 'fbx'} onChange={(v) => set({ robloxCompatible: v })} label="Roblox-compatible FBX (experimental)" />
      </div>
      <Field label="File name">
        <input
          className="input mono"
          value={fileName}
          spellCheck={false}
          onChange={(e) => {
            touched.current = true
            setFileName(e.target.value)
          }}
        />
      </Field>
      {problems.map((p) => (
        <div key={p} className="alert-text fal-hint">
          {p}
        </div>
      ))}
      {warnings.map((w) => (
        <div key={w} className="amber-text fal-hint">
          {w}
        </div>
      ))}
      <div className="row fal-out-actions">
        <button className="btn sm solid" disabled={busy || problems.length > 0 || !projects.length} onClick={() => setSaveOpen(true)} title={projects.length ? 'Copy into a world with provenance (not committed)' : 'Add a world first'}>
          <Save size={12} /> Save to world
        </button>
        <button className="btn sm" disabled={busy || problems.length > 0 || !fileName.trim()} onClick={() => void exportFile()} title="Save a copy anywhere">
          <Download size={12} /> Export…
        </button>
        {run.files
          .filter((f) => !f.preview && f.motionId === motionId)
          .slice(-1)
          .map((f) => (
            <button key={f.fileName} className="btn sm ghost icon" title="Show downloaded files" onClick={() => void api().openPath(f.localPath.replace(/[\\/][^\\/]*$/, ''))}>
              <FolderOpen size={12} />
            </button>
          ))}
      </div>
      {saveOpen && <SaveToWorld req={req} run={run} activeWorld={world} folder={folder} onClose={() => setSaveOpen(false)} onSaved={onSaved} />}
    </div>
  )
}

function SaveToWorld({
  req,
  run,
  activeWorld,
  folder: activeFolder,
  onClose,
  onSaved
}: {
  req: { runId: string; motionId: string; format: UthanaFormat; options: UthanaExportOptions; fileName: string }
  run: UthanaRun
  activeWorld: string | null
  folder?: string
  onClose: () => void
  onSaved: () => void
}) {
  const projects = useStore((s) => s.snap.projects)
  const [project, setProject] = useState(() => [run.world, activeWorld].find((w) => w && projects.some((p) => p.name === w)) ?? projects[0]?.name ?? '')
  const [folder, setFolder] = useState(project === activeWorld && activeFolder ? activeFolder : '')
  const [fileName, setFileName] = useState(req.fileName)
  const [busy, setBusy] = useState(false)
  const [exists, setExists] = useState<string | null>(null)
  const proj = projects.find((p) => p.name === project)

  // the world's animations folder (configured, else an engine-aware suggestion)
  useEffect(() => {
    if (!project) return
    let live = true
    void api()
      .uthanaWorld(project)
      .then((w) => live && setFolder(w.folder))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [project])

  const save = async (overwrite: boolean): Promise<void> => {
    setBusy(true)
    try {
      const r = await api().uthanaExport({ ...req, fileName, dest: 'world', project, folder, overwrite })
      if (r.exists) {
        setExists(r.message)
        return
      }
      if (!r.ok) {
        toast('error', 'Save to world', r.message)
        return
      }
      toast('success', 'Saved to world', `${r.message}${r.provenance ? ` · provenance in ${r.provenance}` : ''} (not committed)`)
      for (const w of r.warnings ?? []) toast('warn', 'Save to world', w)
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
      kicker={`${req.format.toUpperCase()} · ${run.characterName ?? run.characterId}`}
      onClose={onClose}
      width={540}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn solid" disabled={busy || !project || !fileName.trim()} onClick={() => void save(false)}>
            <Save size={13} /> {busy ? 'Downloading…' : 'Save'}
          </button>
        </>
      }
    >
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
          Also writes <span className="mono">.genio/provenance/…</span> (prompt, model, character, download options) and a line in <span className="mono">.genio/spend.jsonl</span>. Nothing is committed:
          review and commit them with the asset.
        </div>
      </div>
      {exists && (
        <Confirm
          title="Replace the existing file?"
          tone="alert"
          confirmLabel="Overwrite"
          body={<>{exists} Overwrite it with this export?</>}
          onConfirm={() => save(true)}
          onClose={() => setExists(null)}
        />
      )}
    </Modal>
  )
}

function UploadModal({
  world,
  onClose,
  confirmPaid,
  onStarted
}: {
  world: string | null
  onClose: () => void
  confirmPaid: (usd: number | undefined, go: () => Promise<void>) => void
  onStarted: (r: UthanaRun) => void
}) {
  const [file, setFile] = useState<UthanaFileInfo | null>(null)
  const [name, setName] = useState('')
  const [autoRig, setAutoRig] = useState(true)
  const [frontFacing, setFrontFacing] = useState(true)
  const [fingers, setFingers] = useState(true)
  const [rerig, setRerig] = useState('')
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const est = estimateUthana('auto-rig', { autoRig })

  const take = (v: UthanaFileInfo | null): void => {
    if (!v) return
    setFile(v)
    if (!name.trim()) setName(v.name.replace(/\.[^.]+$/, ''))
  }
  const pick = async (inWorld: boolean): Promise<void> => {
    try {
      take(await api().uthanaPickFile(inWorld ? world : null, 'character'))
    } catch (e) {
      toast('error', 'Character file', errText(e))
    }
  }
  const drop = (e: DragEvent): void => {
    e.preventDefault()
    setOver(false)
    const f = e.dataTransfer.files[0]
    const p = f ? window.genio.pathForFile(f) : ''
    if (p)
      void api()
        .uthanaInspect(p, 'character', world)
        .then(take)
        .catch((err) => toast('error', 'Character file', errText(err)))
  }
  const upload = (): void => {
    if (!file) return
    confirmPaid(est.usd, async () => {
      setBusy(true)
      const r = await op('Character upload', () =>
        api().uthanaUpload({ world: world ?? undefined, path: file.path, name, autoRig, frontFacing, includeFingers: fingers, rerigTarget: rerig || undefined })
      )
      setBusy(false)
      if (!r) return
      onStarted(r)
      onClose()
    })
  }

  return (
    <Modal
      title="Upload a character"
      kicker={world ?? 'Scratch'}
      onClose={onClose}
      width={560}
      footer={
        <>
          <span className="mono mute anim-modal-cost">{est.text}</span>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn solid" disabled={busy || !file || !name.trim()} onClick={upload}>
            <Upload size={13} /> Upload
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div
          className={cx('fal-file wide', over && 'over')}
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={drop}
        >
          {file ? (
            <div className="mono anim-file">
              <UserRound size={14} /> {file.inWorld ?? file.name} · {bytes(file.bytes)}
            </div>
          ) : (
            <div className="mute">Drop an .fbx, .glb or .gltf (single file, under 30 MB): a humanoid with a head, two arms and two legs.</div>
          )}
          <div className="fal-file-actions">
            {world && (
              <button className="btn sm" onClick={() => void pick(true)}>
                <FolderOpen size={12} /> From {world}
              </button>
            )}
            <button className="btn sm" onClick={() => void pick(false)}>
              <FolderOpen size={12} /> From disk
            </button>
          </div>
        </div>
        <Field label="Name" wide>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Toggle checked={autoRig} onChange={setAutoRig} label="Auto-rig when it has no skeleton" />
        <Toggle checked={frontFacing} disabled={!autoRig} onChange={setFrontFacing} label="Face forward after rigging" />
        <Toggle checked={fingers} onChange={setFingers} label="Finger joints" />
        <Field label="Rerig to">
          <select className="select" value={rerig} onChange={(e) => setRerig(e.target.value)}>
            <option value="">Keep its skeleton</option>
            {UTHANA_RERIG_TARGETS.map((t) => (
              <option key={t} value={t}>
                {t === 'r15' ? 'Roblox R15' : 'Unreal Engine 5'}
              </option>
            ))}
          </select>
        </Field>
        <div className="field-hint wide">
          Genio remembers the character for {world ?? 'Scratch'}. Uploading the same file again returns the same character. A legacy subscription also uses one of its monthly character slots.
        </div>
      </div>
    </Modal>
  )
}

function WorldSettings({ world, state, onClose, onSaved }: { world: string | null; state: UthanaWorldState | null; onClose: () => void; onSaved: (s: UthanaWorldState) => void }) {
  const [folder, setFolder] = useState(typeof state?.config.folder === 'string' ? state.config.folder : '')
  const [busy, setBusy] = useState(false)
  const characters: UthanaCharacterRecord[] = state?.characters ?? []
  const save = async (): Promise<void> => {
    setBusy(true)
    const s = await op('Animation settings', () => api().uthanaWorldConfig(world, { ...(state?.config ?? {}), folder }), () => `${world}/.genio/uthana/config.json saved (not committed)`)
    setBusy(false)
    if (s) {
      onSaved(s)
      onClose()
    }
  }
  return (
    <Modal
      title={`Animation settings · ${world ?? 'Scratch'}`}
      kicker={world ? '.genio/uthana/config.json' : "Genio's data"}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          {world && (
            <button className="btn solid" disabled={busy} onClick={() => void save()}>
              <Save size={13} /> Save settings
            </button>
          )}
        </>
      }
    >
      <div className="form-grid">
        {world ? (
          <Field label="Animations folder" hint="Where Save to world puts exports, relative to the world root." wide>
            <input className="input mono" value={folder} placeholder={state?.folder} spellCheck={false} onChange={(e) => setFolder(e.target.value)} />
          </Field>
        ) : (
          <div className="mute wide">Scratch has no save folder; pick a world when saving.</div>
        )}
        <div className="field-hint wide">The monthly budget and confirm threshold are the world's FAL budget (⚙ on the FAL.ai screen); they cover Animation runs too.</div>
        {characters.length > 0 && (
          <div className="wide anim-chars">
            <span className="label">Characters uploaded in {world ?? 'Scratch'}</span>
            {characters.map((c) => (
              <div key={c.id} className="anim-char-row">
                <span>{c.name}</span>
                <span className="mono mute">{c.id}</span>
                <span className="mute">{c.source}</span>
                <button
                  className="btn sm ghost icon alert"
                  title="Forget it here (Uthana keeps it)"
                  onClick={() => void op('Forget character', () => api().uthanaForgetCharacter(world, c.id)).then((s) => s && onSaved(s))}
                >
                  <Trash size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
