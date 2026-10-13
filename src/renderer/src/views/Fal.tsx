import { useEffect, useState } from 'react'
import { Ban, Copy, FolderOpen, KeyRound, Play, Plus, RotateCcw, Save, Sparkles, Trash, X } from 'lucide-react'
import type { ApiKeyStatus, FalOutput, FalRun } from '@shared/api'
import { api, errText, go, op, toast, useStore } from '../store'
import { Chip, Confirm, Empty, Field, Modal, Tabs, ViewHeader, useNow } from '../components/ui'
import { GlbViewer } from '../components/GlbViewer'
import { requestSystemsSection } from './Systems'
import { FAL_PRESETS, FAL_STATUS, bytes, parseJsonObject, rowsFrom, rowsToObject, runPrompt, type FalPreset, type ParamRow } from '../lib/fal'
import { ago, cx, usd } from '../lib/format'

type Mode = 'fields' | 'json'

interface Draft {
  presetId: string
  endpoint: string
  promptKey: string
  prompt: string
  mode: Mode
  rows: ParamRow[]
  json: string
}

const fromPreset = (p: FalPreset, prompt: string): Draft => ({
  presetId: p.id,
  endpoint: p.endpoint,
  promptKey: p.promptKey ?? '',
  prompt: p.promptKey ? prompt : '',
  mode: 'fields',
  rows: rowsFrom(p.params),
  json: JSON.stringify(p.params, null, 2)
})

// survive view switches (the stage remounts each view)
let keptDraft: Draft | null = null
let keptSelected: string | null = null
let lastSave: { project: string; folder: string } | null = null

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

export function Fal() {
  const [key, setKey] = useState<ApiKeyStatus | null | undefined>(undefined)
  const [runs, setRuns] = useState<FalRun[] | null>(null)
  const [selected, setSelected] = useState<string | null>(keptSelected)
  const [draft, setDraftState] = useState<Draft>(() => keptDraft ?? fromPreset(FAL_PRESETS[0], ''))
  const [paramErr, setParamErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saveTarget, setSaveTarget] = useState<{ run: FalRun; index: number } | null>(null)

  const setDraft = (patch: Partial<Draft>): void => {
    setDraftState((d) => (keptDraft = { ...d, ...patch }))
    setParamErr(null)
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
    return window.genio.on((ev) => {
      if (ev.type === 'fal-run') setRuns((rs) => upsert(rs ?? [], ev.run))
    })
  }, [])
  useEffect(() => {
    keptSelected = selected
  }, [selected])

  const run = runs?.find((r) => r.id === selected) ?? runs?.[0]

  const buildInput = (): Record<string, unknown> => {
    const input = draft.mode === 'json' ? parseJsonObject(draft.json) : rowsToObject(draft.rows)
    if (draft.promptKey.trim() && draft.prompt.trim()) input[draft.promptKey.trim()] = draft.prompt
    return input
  }

  const submit = async (): Promise<void> => {
    let input: Record<string, unknown>
    try {
      input = buildInput()
    } catch (e) {
      setParamErr(errText(e))
      return
    }
    setBusy(true)
    const r = await op('FAL run', () => api().falRun({ endpoint: draft.endpoint, input }))
    setBusy(false)
    if (r) {
      setRuns((rs) => upsert(rs ?? [], r))
      setSelected(r.id)
    }
  }

  const reuse = (r: FalRun): void => {
    const preset = FAL_PRESETS.find((p) => p.endpoint === r.endpoint)
    const promptKey = preset ? preset.promptKey ?? '' : ['prompt', 'text'].find((k) => typeof r.input[k] === 'string') ?? 'prompt'
    const rest = { ...r.input }
    const prompt = promptKey && typeof rest[promptKey] === 'string' ? (rest[promptKey] as string) : ''
    if (prompt) delete rest[promptKey]
    setDraft({ presetId: preset?.id ?? 'custom', endpoint: r.endpoint, promptKey, prompt, mode: 'fields', rows: rowsFrom(rest), json: JSON.stringify(rest, null, 2) })
  }

  const switchMode = (m: Mode): void => {
    if (m === draft.mode) return
    if (m === 'json') setDraft({ mode: m, json: JSON.stringify(rowsToObject(draft.rows), null, 2) })
    else {
      try {
        setDraft({ mode: m, rows: rowsFrom(parseJsonObject(draft.json)) })
      } catch (e) {
        setParamErr(`Fix the JSON first: ${errText(e)}`)
      }
    }
  }

  const preset = FAL_PRESETS.find((p) => p.id === draft.presetId)
  const groups = [...new Set(FAL_PRESETS.map((p) => p.group))]
  const noKey = key === null || key?.set === false

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
              <Field label="Preset">
                <select
                  className="select"
                  value={preset ? draft.presetId : 'custom'}
                  onChange={(e) => {
                    const p = FAL_PRESETS.find((x) => x.id === e.target.value)
                    if (p) setDraft(fromPreset(p, draft.prompt))
                  }}
                >
                  {groups.map((g) => (
                    <optgroup key={g} label={g}>
                      {FAL_PRESETS.filter((p) => p.group === g).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                  <option value="custom">Custom endpoint</option>
                </select>
              </Field>
              <Field label="Endpoint id" hint={preset?.hint ?? 'Any FAL model id, e.g. fal-ai/flux/dev (from its fal.ai page).'}>
                <input
                  className="input mono"
                  value={draft.endpoint}
                  spellCheck={false}
                  placeholder="owner/model[/path]"
                  onChange={(e) => setDraft({ endpoint: e.target.value, presetId: FAL_PRESETS.find((p) => p.endpoint === e.target.value.trim())?.id ?? 'custom' })}
                />
              </Field>
              <div className="field">
                <span className="label fal-prompt-label">
                  Prompt
                  <span className="mute">sent as</span>
                  <input
                    className="input mono fal-key-input"
                    value={draft.promptKey}
                    placeholder="(none)"
                    spellCheck={false}
                    onChange={(e) => setDraft({ promptKey: e.target.value.replace(/\s/g, '') })}
                  />
                </span>
                <textarea
                  className="textarea"
                  rows={4}
                  value={draft.prompt}
                  disabled={!draft.promptKey}
                  placeholder={draft.promptKey ? 'A mossy stone golem, game asset, three-quarter view' : 'This endpoint takes no prompt; use the parameters below.'}
                  onChange={(e) => setDraft({ prompt: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault()
                      void submit()
                    }
                  }}
                />
              </div>
              <div className="field">
                <div className="fal-params-head">
                  <span className="label">Parameters</span>
                  <Tabs<Mode> value={draft.mode} onChange={switchMode} tabs={[{ id: 'fields', label: 'Fields' }, { id: 'json', label: 'JSON' }]} />
                </div>
                {draft.mode === 'fields' ? (
                  <div className="fal-params">
                    {draft.rows.map((r, i) => {
                      const upd = (patch: Partial<ParamRow>): void => setDraft({ rows: draft.rows.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
                      return (
                        <div key={i} className="fal-param">
                          <input className="input mono" value={r.key} placeholder="key" spellCheck={false} onChange={(e) => upd({ key: e.target.value })} />
                          <input className="input mono" value={r.value} placeholder="value (blank = not sent)" spellCheck={false} onChange={(e) => upd({ value: e.target.value })} />
                          <button className="btn sm ghost icon" title="Remove" onClick={() => setDraft({ rows: draft.rows.filter((_, j) => j !== i) })}>
                            <X size={12} />
                          </button>
                        </div>
                      )
                    })}
                    <button className="btn sm ghost" onClick={() => setDraft({ rows: [...draft.rows, { key: '', value: '' }] })}>
                      <Plus size={12} /> Field
                    </button>
                    <div className="field-hint">Numbers, true/false and {'{…}'} / […] JSON are typed; anything else is sent as text.</div>
                  </div>
                ) : (
                  <textarea className="textarea mono" rows={8} value={draft.json} spellCheck={false} onChange={(e) => setDraft({ json: e.target.value })} />
                )}
                {paramErr && <div className="alert-text fal-err">{paramErr}</div>}
              </div>
              <button className="btn solid" disabled={busy || !draft.endpoint.trim() || key === undefined} onClick={() => void submit()}>
                <Play size={13} /> Run
              </button>
            </section>
          )}
          <section className="panel fal-history">
            <div className="label">History</div>
            {!runs && (
              <div className="bar indeterminate">
                <i />
              </div>
            )}
            {runs?.length === 0 && <div className="mute side-empty">No runs yet.</div>}
            <div className="fal-history-list">
              {runs?.map((r) => (
                <HistoryRow key={r.id} r={r} on={r.id === run?.id} onClick={() => setSelected(r.id)} />
              ))}
            </div>
          </section>
        </div>
        <section className="panel fal-detail">
          {run ? (
            <RunDetail run={run} onReuse={() => reuse(run)} onSave={(index) => setSaveTarget({ run, index })} onDeleted={() => setSelected(null)} />
          ) : (
            <Empty icon={<Sparkles size={34} className="neon-text" />} title="Nothing generated yet">
              Pick a preset or type any FAL endpoint id, write a prompt and run it. Results preview here and are kept in Genio's data folder until you save them to a world.
            </Empty>
          )}
        </section>
      </div>
      {saveTarget && <SaveToWorld run={saveTarget.run} index={saveTarget.index} onClose={() => setSaveTarget(null)} />}
    </div>
  )
}

function HistoryRow({ r, on, onClick }: { r: FalRun; on: boolean; onClick: () => void }) {
  const st = FAL_STATUS[r.status]
  const thumb = r.outputs.find((o) => o.kind === 'image' && (o.mediaUrl || o.url))
  return (
    <button className={cx('fal-hrow', on && 'on')} onClick={onClick}>
      <div className="fal-thumb">{thumb ? <img src={thumb.mediaUrl ?? thumb.url} alt="" /> : <span className="mono">{r.outputs[0]?.kind ?? '·'}</span>}</div>
      <div className="fal-hmain">
        <div className="fal-hprompt">{runPrompt(r)}</div>
        <div className="mono mute fal-hmeta">
          {r.endpoint} · {ago(r.createdAt)}
        </div>
      </div>
      <Chip tone={st.tone} pulse={st.live}>
        {st.label}
      </Chip>
    </button>
  )
}

function RunDetail({ run, onReuse, onSave, onDeleted }: { run: FalRun; onReuse: () => void; onSave: (i: number) => void; onDeleted: () => void }) {
  const st = FAL_STATUS[run.status]
  const now = useNow(st.live ? 1000 : 60_000)
  const [del, setDel] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  return (
    <div className="fal-run">
      <div className="fal-run-head">
        <div className="fal-run-title">
          <div className="mono">{run.endpoint}</div>
          <div className="mute fal-run-meta">
            {new Date(run.createdAt).toLocaleString()} · {duration(run.createdAt, run.completedAt, now)}
            {run.costUsd !== undefined && <> · {usd(run.costUsd)}</>}
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
          <button className="btn sm" onClick={onReuse} title="Load this run's endpoint and inputs into the form">
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
            <OutputCard key={i} o={o} onSave={() => onSave(i)} />
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

function OutputCard({ o, onSave }: { o: FalOutput; onSave: () => void }) {
  const src = o.mediaUrl
  const isGlb = /\.glb$/i.test(o.fileName)
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
        {o.localPath && (
          <>
            <button className="btn sm" onClick={() => void api().openPath(o.localPath!)} title="Open with the default app">
              Open file
            </button>
            <button className="btn sm ghost icon" title="Show folder" onClick={() => void api().openPath(dirOf(o.localPath!))}>
              <FolderOpen size={12} />
            </button>
          </>
        )}
        {o.url && (
          <button
            className="btn sm ghost icon"
            title="Copy FAL URL (use it as another run's input)"
            onClick={() => void navigator.clipboard.writeText(o.url).then(() => toast('success', 'URL copied'))}
          >
            <Copy size={12} />
          </button>
        )}
      </div>
    </div>
  )
}

function SaveToWorld({ run, index, onClose }: { run: FalRun; index: number; onClose: () => void }) {
  const projects = useStore((s) => s.snap.projects)
  const o = run.outputs[index]
  const [project, setProject] = useState(() => (lastSave && projects.some((p) => p.name === lastSave!.project) ? lastSave.project : projects[0]?.name ?? ''))
  const [folder, setFolder] = useState(lastSave?.project === project ? lastSave.folder : '')
  const [fileName, setFileName] = useState(o.fileName)
  const [busy, setBusy] = useState(false)
  const [exists, setExists] = useState<string | null>(null)

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
      lastSave = { project, folder }
      toast('success', 'Saved to world', r.message)
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

  const root = projects.find((p) => p.name === project)?.path
  return (
    <Modal
      title="Save to world"
      kicker={o.fileName}
      onClose={onClose}
      width={520}
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
            <select
              className="select"
              value={project}
              onChange={(e) => {
                setProject(e.target.value)
                setFolder('')
              }}
            >
              {projects.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Folder" hint={root ? <span className="mono">{root}</span> : undefined} wide>
            <div className="row">
              <input className="input mono" value={folder} placeholder="(world root) e.g. Assets/Art/Generated" spellCheck={false} onChange={(e) => setFolder(e.target.value)} />
              <button className="btn sm" onClick={() => void browse()} disabled={!project}>
                <FolderOpen size={12} /> Browse
              </button>
            </div>
          </Field>
          <Field label="File name" wide>
            <input className="input mono" value={fileName} spellCheck={false} onChange={(e) => setFileName(e.target.value)} />
          </Field>
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
