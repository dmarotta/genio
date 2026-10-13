import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronRight, Dices, FileUp, FolderOpen, History, Link, X } from 'lucide-react'
import type { FalOutputKind, FalRun } from '@shared/api'
import { coerceText, isEmptyValue, type FormField, type FormModel } from '@shared/fal-schema'
import { api, errText, toast } from '../store'
import { Toggle } from './ui'
import { fileLabel } from '../lib/fal'
import { cx } from '../lib/format'

type Values = Record<string, unknown>

interface FormProps {
  model: FormModel
  values: Values
  errors: Record<string, string>
  onChange: (key: string, v: unknown) => void
  /** this world's runs, for "earlier output" file picks */
  runs: FalRun[]
  world: string | null
  onSubmit: () => void
}

const show = (v: unknown): string => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v))

/** Schema-driven parameters: required, essentials, then More options (empty = FAL default). */
export function FalForm({ model, values, errors, onChange, runs, world, onSubmit }: FormProps) {
  const [more, setMore] = useState(false)
  const known = useMemo(() => new Set(model.fields.filter((f) => f.section !== 'hidden').map((f) => f.key)), [model])
  const extras = Object.keys(values).filter((k) => !known.has(k) && !isEmptyValue(values[k]))
  const moreSet = model.more.filter((f) => !isEmptyValue(values[f.key])).length
  const moreErr = model.more.some((f) => errors[f.key])
  useEffect(() => {
    if (moreErr) setMore(true)
  }, [moreErr])
  const row = (f: FormField): ReactNode => (
    <FieldRow key={f.key} f={f} value={values[f.key]} error={errors[f.key]} onChange={(v) => onChange(f.key, v)} runs={runs} world={world} onSubmit={onSubmit} />
  )
  return (
    <div className="fal-form">
      {model.required.map(row)}
      {model.essentials.length > 0 && (
        <>
          <div className="label fal-sec">Essentials</div>
          {model.essentials.map(row)}
        </>
      )}
      {model.more.length > 0 && (
        <>
          <button className={cx('fal-more', more && 'open')} onClick={() => setMore((m) => !m)}>
            <ChevronRight size={13} />
            <span className="label">More options ({model.more.length})</span>
            <span className="mute">{moreSet ? `${moreSet} set` : 'empty = FAL default'}</span>
          </button>
          {more && <div className="fal-more-body">{model.more.map(row)}</div>}
        </>
      )}
      {extras.length > 0 && (
        <div className="fal-extras">
          <div className="label fal-sec">Also sent (set in JSON)</div>
          {extras.map((k) => (
            <div key={k} className="fal-extra mono">
              <span className="fal-extra-k">{k}</span>
              <span className="fal-extra-v" title={show(values[k])}>
                {show(values[k])}
              </span>
              <button className="btn sm ghost icon" title="Don't send" onClick={() => onChange(k, undefined)}>
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function FieldRow({
  f,
  value,
  error,
  onChange,
  runs,
  world,
  onSubmit
}: {
  f: FormField
  value: unknown
  error?: string
  onChange: (v: unknown) => void
  runs: FalRun[]
  world: string | null
  onSubmit: () => void
}) {
  const set = !isEmptyValue(value)
  const genio = f.genioDefault !== undefined && set && JSON.stringify(value) === JSON.stringify(f.genioDefault)
  const count = f.maxLength !== undefined && typeof value === 'string' ? `${value.length}/${f.maxLength}` : ''
  return (
    <div className={cx('fal-field', error && 'bad')}>
      <div className="fal-field-head">
        <span className="fal-field-title" title={f.description}>
          {f.title}
          {f.required && <span className="neon-text"> *</span>}
        </span>
        {genio && <span className="fal-tag" title="Genio's game-friendly default">Genio</span>}
        <span className="fal-field-aside mute mono">{count}</span>
        {!f.required && set && (
          <button className="btn sm ghost icon fal-clear" title="Clear: FAL's default applies" onClick={() => onChange(undefined)}>
            <X size={11} />
          </button>
        )}
      </div>
      <Widget f={f} value={value} onChange={onChange} runs={runs} world={world} onSubmit={onSubmit} />
      {error ? <div className="alert-text fal-field-err">{error}</div> : f.description && f.widget !== 'toggle' && f.section === 'required' ? <div className="field-hint">{f.description}</div> : null}
    </div>
  )
}

const defText = (f: FormField): string => (f.hasDefault ? `default ${show(f.default)}` : f.nullable || !f.required ? 'FAL decides' : '')

function Widget({ f, value, onChange, runs, world, onSubmit }: { f: FormField; value: unknown; onChange: (v: unknown) => void; runs: FalRun[]; world: string | null; onSubmit: () => void }) {
  switch (f.widget) {
    case 'prompt':
      return (
        <textarea
          className="textarea"
          rows={f.required ? 4 : 2}
          value={typeof value === 'string' ? value : ''}
          placeholder={f.example ?? defText(f)}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              onSubmit()
            }
          }}
        />
      )
    case 'text':
      return <input className="input" value={typeof value === 'string' ? value : show(value)} placeholder={f.example ?? defText(f)} onChange={(e) => onChange(e.target.value)} />
    case 'number':
      return <NumberBox f={f} value={value} onChange={onChange} />
    case 'seed':
      return (
        <div className="row fal-seed">
          <NumberBox f={f} value={value} onChange={onChange} placeholder="random" />
          <button className="btn sm ghost icon" title="Roll a seed (keep it to reproduce)" onClick={() => onChange(Math.floor(Math.random() * 2_147_483_647))}>
            <Dices size={13} />
          </button>
        </div>
      )
    case 'slider': {
      const cur = typeof value === 'number' ? value : typeof f.default === 'number' ? f.default : f.min ?? 0
      return (
        <div className={cx('fal-slider', isEmptyValue(value) && 'unset')}>
          <input type="range" min={f.min} max={f.max} step={f.step ?? 'any'} value={cur} onChange={(e) => onChange(Number(e.target.value))} />
          <NumberBox f={f} value={value} onChange={onChange} />
        </div>
      )
    }
    case 'toggle': {
      const on = typeof value === 'boolean' ? value : f.default === true
      return (
        <div className={cx('fal-toggle', value === undefined && 'unset')}>
          <Toggle checked={on} onChange={(v) => onChange(v)} label={value === undefined ? <span className="mute">{f.hasDefault ? `default ${on ? 'on' : 'off'}` : 'FAL decides'}</span> : on ? 'on' : 'off'} />
        </div>
      )
    }
    case 'segmented':
      return (
        <div className="fal-seg">
          {f.options!.map((o) => (
            <button
              key={String(o)}
              className={cx('fal-seg-opt', value === o && 'on', isEmptyValue(value) && f.default === o && 'def')}
              title={isEmptyValue(value) && f.default === o ? "FAL's default" : undefined}
              onClick={() => onChange(value === o && !f.required ? undefined : o)}
            >
              {String(o)}
            </button>
          ))}
        </div>
      )
    case 'select':
      return (
        <select
          className="select"
          value={isEmptyValue(value) ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? undefined : f.options!.find((o) => String(o) === e.target.value))}
        >
          <option value="">{f.hasDefault ? `default (${show(f.default)})` : f.required ? 'pick one' : 'FAL decides'}</option>
          {f.options!.map((o) => (
            <option key={String(o)} value={String(o)}>
              {String(o)}
            </option>
          ))}
        </select>
      )
    case 'image_size':
      return <ImageSize f={f} value={value} onChange={onChange} />
    case 'file':
    case 'files':
      return <FileInput f={f} value={value} onChange={onChange} runs={runs} world={world} />
    default:
      return <JsonBox f={f} value={value} onChange={onChange} />
  }
}

function NumberBox({ f, value, onChange, placeholder }: { f: FormField; value: unknown; onChange: (v: unknown) => void; placeholder?: string }) {
  const [txt, setTxt] = useState(show(value))
  useEffect(() => {
    if (coerceText(f, txt) !== value) setTxt(show(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  return (
    <input
      className="input mono fal-num"
      inputMode="decimal"
      value={txt}
      placeholder={placeholder ?? defText(f)}
      onChange={(e) => {
        setTxt(e.target.value)
        onChange(coerceText(f, e.target.value))
      }}
    />
  )
}

function JsonBox({ f, value, onChange }: { f: FormField; value: unknown; onChange: (v: unknown) => void }) {
  const [txt, setTxt] = useState(value === undefined ? '' : JSON.stringify(value))
  useEffect(() => {
    if (value === undefined) setTxt('')
  }, [value])
  return (
    <textarea
      className="textarea mono fal-json-field"
      rows={2}
      value={txt}
      spellCheck={false}
      placeholder={f.hasDefault ? `default ${JSON.stringify(f.default)}` : 'JSON'}
      onChange={(e) => {
        setTxt(e.target.value)
        onChange(coerceText({ ...f, widget: 'json' }, e.target.value))
      }}
    />
  )
}

function ImageSize({ f, value, onChange }: { f: FormField; value: unknown; onChange: (v: unknown) => void }) {
  const custom = value && typeof value === 'object' ? (value as { width?: number; height?: number }) : null
  const [w, setW] = useState(custom?.width ? String(custom.width) : '1024')
  const [h, setH] = useState(custom?.height ? String(custom.height) : '1024')
  const setCustom = (ws: string, hs: string): void => {
    const wn = Number(ws)
    const hn = Number(hs)
    if (wn > 0 && hn > 0) onChange({ width: Math.round(wn), height: Math.round(hn) })
  }
  return (
    <div className="fal-size">
      <div className="fal-seg wrap">
        {(f.options ?? []).map((o) => (
          <button
            key={String(o)}
            className={cx('fal-seg-opt', value === o && 'on', isEmptyValue(value) && f.default === o && 'def')}
            onClick={() => onChange(value === o && !f.required ? undefined : o)}
          >
            {String(o).replace(/_/g, ' ')}
          </button>
        ))}
        <button className={cx('fal-seg-opt', custom && 'on')} onClick={() => (custom ? onChange(undefined) : setCustom(w, h))}>
          W×H
        </button>
      </div>
      {custom && (
        <div className="row fal-wh">
          <input className="input mono" value={w} onChange={(e) => (setW(e.target.value), setCustom(e.target.value, h))} />
          <span className="mute">×</span>
          <input className="input mono" value={h} onChange={(e) => (setH(e.target.value), setCustom(w, e.target.value))} />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- files

interface Pickable {
  value: string
  thumb?: string
  name: string
  kind: FalOutputKind
}

/** Earlier outputs of this world, newest first; the local copy is preferred over FAL's short-lived URL. */
function earlierOutputs(runs: FalRun[], kind: FalOutputKind | 'any'): Pickable[] {
  const out: Pickable[] = []
  for (const r of runs) {
    for (const o of r.outputs) {
      if (kind !== 'any' && o.kind !== kind) continue
      const value = o.localPath ? `@file:${o.localPath}` : o.url
      if (!value) continue
      out.push({ value, thumb: o.kind === 'image' ? o.mediaUrl ?? o.url : undefined, name: o.fileName, kind: o.kind })
    }
  }
  return out.slice(0, 30)
}

function FileInput({ f, value, onChange, runs, world }: { f: FormField; value: unknown; onChange: (v: unknown) => void; runs: FalRun[]; world: string | null }) {
  const multi = f.widget === 'files'
  const list = (multi ? (Array.isArray(value) ? value : []) : typeof value === 'string' && value ? [value] : []).filter((x): x is string => typeof x === 'string')
  const kind = f.fileKind ?? 'any'
  const [earlier, setEarlier] = useState(false)
  const [url, setUrl] = useState('')
  const [over, setOver] = useState(false)
  const picks = useMemo(() => earlierOutputs(runs, kind), [runs, kind])
  const thumbs = useMemo(() => new Map(earlierOutputs(runs, 'any').map((p) => [p.value, p.thumb])), [runs])

  const add = (v: string): void => {
    if (!v) return
    if (multi) onChange(list.includes(v) ? list : [...list, v])
    else onChange(v)
    setEarlier(false)
  }
  const remove = (v: string): void => (multi ? onChange(list.filter((x) => x !== v)) : onChange(undefined))
  const pick = async (inWorld: boolean): Promise<void> => {
    try {
      const p = await api().falPickFile(inWorld ? world : null, kind === 'any' ? undefined : kind)
      if (p) add(`@file:${p}`)
    } catch (e) {
      toast('error', 'Pick file', errText(e))
    }
  }

  return (
    <div
      className={cx('fal-file', over && 'over')}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        for (const file of Array.from(e.dataTransfer.files).slice(0, multi ? 14 : 1)) {
          const p = window.genio.pathForFile(file)
          if (p) add(`@file:${p}`)
        }
      }}
    >
      {list.length > 0 && (
        <div className="fal-file-list">
          {list.map((v) => {
            const th = thumbs.get(v) ?? (/^https:.*\.(png|jpe?g|webp|gif)(\?|$)/i.test(v) ? v : undefined)
            return (
              <div key={v} className="fal-file-chip" title={v.startsWith('data:') ? 'inline data' : v.replace(/^@file:/, '')}>
                {th ? <img src={th} alt="" /> : <span className="fal-file-ico mono">{kind === 'any' ? 'file' : kind}</span>}
                <span className="mono">{fileLabel(v)}</span>
                <button className="btn sm ghost icon" title="Remove" onClick={() => remove(v)}>
                  <X size={11} />
                </button>
              </div>
            )
          })}
        </div>
      )}
      {(multi || list.length === 0) && (
        <>
          <div className="fal-file-actions">
            <button className={cx('btn sm', earlier && 'on')} disabled={!picks.length} title={picks.length ? undefined : `No earlier ${kind === 'any' ? '' : kind + ' '}outputs here yet`} onClick={() => setEarlier((x) => !x)}>
              <History size={12} /> Earlier output
            </button>
            {world && (
              <button className="btn sm" onClick={() => void pick(true)} title={`A file inside ${world}`}>
                <FolderOpen size={12} /> World file
              </button>
            )}
            <button className="btn sm ghost" onClick={() => void pick(false)} title="Any local file (or drop one here)">
              <FileUp size={12} /> Local file
            </button>
          </div>
          <div className="row fal-url">
            <Link size={12} className="mute" />
            <input
              className="input mono"
              value={url}
              placeholder={`drop a ${kind === 'any' ? 'file' : kind} here, or paste a URL`}
              spellCheck={false}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && url.trim()) {
                  add(url.trim())
                  setUrl('')
                }
              }}
              onBlur={() => {
                if (/^https?:\/\//.test(url.trim())) {
                  add(url.trim())
                  setUrl('')
                }
              }}
            />
          </div>
          {earlier && (
            <div className="fal-earlier">
              {picks.map((p) => (
                <button key={p.value} className="fal-earlier-item" title={p.name} onClick={() => add(p.value)}>
                  {p.thumb ? <img src={p.thumb} alt="" /> : <span className="mono">{p.kind}</span>}
                  <span className="mono">{p.name}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
