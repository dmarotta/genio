import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AudioLines, Box, ChevronDown, Film, Globe, Image as ImageIcon, RefreshCw, Search, Star, X } from 'lucide-react'
import type { FalCatalogue, FalCatalogueEntry, FalOutputKind, FalRecipe, FalSearchHit } from '@shared/api'
import { byTier, entryHaystack, matchScore } from '@shared/fal'
import { api, errText } from '../store'
import { KIND_LABEL, priceOf, shortPrice } from '../lib/fal'
import { ago, cx } from '../lib/format'

export const KIND_ICON: Record<FalOutputKind, ReactNode> = {
  image: <ImageIcon size={13} />,
  audio: <AudioLines size={13} />,
  video: <Film size={13} />,
  model: <Box size={13} />,
  other: <Globe size={13} />
}

type Row =
  | { type: 'recipe'; key: string; recipe: FalRecipe; entry?: FalCatalogueEntry }
  | { type: 'entry'; key: string; entry: FalCatalogueEntry }
  | { type: 'more'; key: string; job: string; count: number }
  | { type: 'hit'; key: string; hit: FalSearchHit }
  | { type: 'custom'; key: string; endpoint: string }
  | { type: 'search'; key: string }

type Section = { label: string; rows: Row[] }

const ENDPOINT_RE = /^[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*$/

export interface PickerProps {
  catalogue: FalCatalogue | null
  recipes: FalRecipe[]
  worldLabel: string
  endpoint: string
  open: boolean
  setOpen: (v: boolean) => void
  onPick: (endpoint: string) => void
  onRecipe: (r: FalRecipe) => void
  onDeleteRecipe: (r: FalRecipe) => void
  onRefresh: () => void
}

/** Search popover: job chips, this world's recipes on top, the curated list, then "Search all FAL". */
export function FalPicker({ catalogue, recipes, worldLabel, endpoint, open, setOpen, onPick, onRecipe, onDeleteRecipe, onRefresh }: PickerProps) {
  const [q, setQ] = useState('')
  const [job, setJob] = useState<string>('all')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [sel, setSel] = useState(0)
  const [hits, setHits] = useState<FalSearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchErr, setSearchErr] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)

  const entries = catalogue?.entries ?? []
  const jobs = catalogue?.jobs ?? []
  const jobLabel = (id: string): string => jobs.find((j) => j.id === id)?.label ?? id
  const current = entries.find((e) => e.endpoint === endpoint)

  useEffect(() => {
    if (!open) return
    setQ('')
    setSel(0)
    setHits(null)
    setSearchErr(null)
    setTimeout(() => input.current?.focus(), 10)
    const away = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [open, setOpen])

  useEffect(() => {
    setHits(null)
    setSearchErr(null)
    setSel(0)
  }, [q, job])

  const sections = useMemo<Section[]>(() => {
    const needle = q.trim()
    const out: Section[] = []
    const inJob = (e: FalCatalogueEntry): boolean => job === 'all' || e.job === job
    const recipeRows: Row[] = recipes
      .map((r) => ({ r, e: entries.find((x) => x.endpoint === r.endpoint) }))
      .filter(({ r, e }) => (!e || inJob(e)) && matchScore(needle, `${r.label} ${r.endpoint} ${e?.label ?? ''}`) >= 0)
      .map(({ r, e }) => ({ type: 'recipe', key: `r:${r.id}`, recipe: r, entry: e }))
    if (recipeRows.length) out.push({ label: `★ ${worldLabel}`, rows: recipeRows })
    if (needle) {
      const rows: Row[] = entries
        .filter(inJob)
        .map((e) => ({ e, s: matchScore(needle, entryHaystack(e, jobLabel(e.job))) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => a.s - b.s || byTier(a.e, b.e))
        .map(({ e }) => ({ type: 'entry', key: `e:${e.endpoint}`, entry: e }))
      if (rows.length) out.push({ label: 'Curated', rows })
    } else {
      for (const j of jobs) {
        if (job !== 'all' && j.id !== job) continue
        const all = entries.filter((e) => e.job === j.id).sort(byTier)
        if (!all.length) continue
        const open = expanded.has(j.id) || job === j.id
        const core = all.filter((e) => e.tier === 'core' || e.endpoint === endpoint || e.fromWorld)
        const shown = open ? all : core
        const rows: Row[] = shown.map((e) => ({ type: 'entry', key: `e:${e.endpoint}`, entry: e }))
        if (!open && all.length > shown.length) rows.push({ type: 'more', key: `m:${j.id}`, job: j.id, count: all.length - shown.length })
        out.push({ label: j.label, rows })
      }
    }
    if (needle) {
      const tail: Row[] = []
      if (ENDPOINT_RE.test(needle) && !entries.some((e) => e.endpoint === needle)) tail.push({ type: 'custom', key: `c:${needle}`, endpoint: needle })
      if (hits) tail.push(...hits.filter((h) => !entries.some((e) => e.endpoint === h.endpoint)).map((h): Row => ({ type: 'hit', key: `h:${h.endpoint}`, hit: h })))
      else tail.push({ type: 'search', key: 'search' })
      out.push({ label: 'All FAL · not curated', rows: tail })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, job, entries, jobs, recipes, expanded, hits, endpoint, worldLabel])

  const flat = sections.flatMap((s) => s.rows)
  const selKey = flat[Math.min(sel, flat.length - 1)]?.key

  useEffect(() => {
    list.current?.querySelector('.fal-pick-row.on')?.scrollIntoView({ block: 'nearest' })
  }, [selKey])

  const searchAll = async (): Promise<void> => {
    const t = q.trim()
    if (!t || searching) return
    setSearching(true)
    setSearchErr(null)
    try {
      setHits(await api().falSearch(t))
    } catch (e) {
      setSearchErr(errText(e))
      setHits([])
    } finally {
      setSearching(false)
    }
  }

  const choose = (r: Row | undefined): void => {
    if (!r) return
    if (r.type === 'more') {
      setExpanded((s) => new Set([...s, r.job]))
      return
    }
    if (r.type === 'search') {
      void searchAll()
      return
    }
    if (r.type === 'recipe') onRecipe(r.recipe)
    else if (r.type === 'entry') onPick(r.entry.endpoint)
    else if (r.type === 'hit') onPick(r.hit.endpoint)
    else onPick(r.endpoint)
    setOpen(false)
  }

  const unlisted = (id: string): boolean => catalogue?.info[id]?.listed === false

  const triggerLabel = current ? current.label : endpoint || 'Pick a model'
  return (
    <div className="fal-picker" ref={root}>
      <button className={cx('fal-pick-btn', open && 'open')} onClick={() => setOpen(!open)} title="Pick a model (Ctrl+M)">
        <span className="fal-pick-ico">{KIND_ICON[current?.output ?? 'other']}</span>
        <span className="fal-pick-main">
          <span className="fal-pick-label">{triggerLabel}</span>
          <span className="fal-pick-sub mono">{current ? `${jobLabel(current.job)} · ${endpoint}` : endpoint ? 'not curated · raw schema' : 'Ctrl+M'}</span>
        </span>
        {endpoint && unlisted(endpoint) && <span className="fal-tag amber">unlisted</span>}
        <ChevronDown size={14} className="mute" />
      </button>
      {open && (
        <div className="fal-pop panel glow rise">
          <div className="fal-pop-search">
            <Search size={14} className="mute" />
            <input
              ref={input}
              value={q}
              placeholder="Search models, jobs, endpoint ids…"
              spellCheck={false}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setSel((s) => Math.min(flat.length - 1, s + 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setSel((s) => Math.max(0, s - 1))
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  choose(flat[Math.min(sel, flat.length - 1)])
                } else if (e.key === 'Tab' && q.trim()) {
                  e.preventDefault()
                  void searchAll()
                } else if (e.key === 'Escape') {
                  e.stopPropagation()
                  setOpen(false)
                }
              }}
            />
            <kbd>Esc</kbd>
          </div>
          <div className="fal-chips">
            <button className={cx('fal-chip', job === 'all' && 'on')} onClick={() => setJob('all')}>
              All
            </button>
            {jobs.map((j) => (
              <button key={j.id} className={cx('fal-chip', job === j.id && 'on')} onClick={() => setJob(j.id)}>
                {j.label}
              </button>
            ))}
          </div>
          <div className="fal-pick-list" ref={list}>
            {!catalogue && <div className="mute fal-pick-empty">Loading the catalogue…</div>}
            {sections.map((s) => (
              <div key={s.label} className="fal-pick-sec">
                <div className="label fal-pick-sec-label">{s.label}</div>
                {s.rows.map((r) => (
                  <PickRow
                    key={r.key}
                    r={r}
                    on={r.key === selKey}
                    current={(r.type === 'entry' && r.entry.endpoint === endpoint) || (r.type === 'hit' && r.hit.endpoint === endpoint)}
                    catalogue={catalogue}
                    unlisted={r.type === 'entry' && unlisted(r.entry.endpoint)}
                    searching={searching}
                    onHover={() => setSel(flat.findIndex((x) => x.key === r.key))}
                    onClick={() => choose(r)}
                    onDelete={r.type === 'recipe' ? () => onDeleteRecipe(r.recipe) : undefined}
                  />
                ))}
              </div>
            ))}
            {searchErr && <div className="alert-text fal-pick-empty">{searchErr}</div>}
            {hits && hits.length === 0 && !searchErr && <div className="mute fal-pick-empty">No other FAL model matches “{q.trim()}”.</div>}
          </div>
          <div className="fal-pop-foot mute">
            <span>↑↓ ↵ pick · Tab searches all FAL · ★ recipes are saved per world</span>
            <button className="btn sm ghost" onClick={onRefresh} disabled={catalogue?.refreshing} title={catalogue?.error ?? 'Refresh models, schemas and prices from FAL'}>
              <RefreshCw size={11} className={cx(catalogue?.refreshing && 'spin')} />
              {catalogue?.refreshing ? 'refreshing' : catalogue?.refreshedAt ? `checked ${ago(catalogue.refreshedAt)}` : 'not checked yet'}
              {catalogue?.error && <span className="amber-text"> · stale</span>}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function PickRow({
  r,
  on,
  current,
  catalogue,
  unlisted,
  searching,
  onHover,
  onClick,
  onDelete
}: {
  r: Row
  on: boolean
  current: boolean
  catalogue: FalCatalogue | null
  unlisted: boolean
  searching: boolean
  onHover: () => void
  onClick: () => void
  onDelete?: () => void
}) {
  let icon: ReactNode = null
  let label: ReactNode = null
  let hint: ReactNode = null
  let aside: ReactNode = null
  if (r.type === 'entry') {
    const e = r.entry
    icon = KIND_ICON[e.output]
    label = (
      <>
        {e.label}
        {e.tier !== 'core' && <span className="fal-tier">{e.tier}</span>}
        {e.fromWorld && <span className="fal-tier">world</span>}
      </>
    )
    hint = e.hint
    aside = (
      <>
        {unlisted && <span className="fal-tag amber" title="FAL no longer lists this endpoint">unlisted</span>}
        <span className="fal-kind">{KIND_LABEL[e.output]}</span>
        <span className="mono fal-price">{shortPrice(e, priceOf(catalogue, e, e.endpoint))}</span>
      </>
    )
  } else if (r.type === 'recipe') {
    icon = <Star size={13} />
    label = r.recipe.label
    hint = r.entry?.label ?? r.recipe.endpoint
    aside = (
      <>
        {r.entry && <span className="fal-kind">{KIND_LABEL[r.entry.output]}</span>}
        {onDelete && (
          <span
            role="button"
            className="fal-row-del"
            title="Delete recipe"
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
          >
            <X size={11} />
          </span>
        )}
      </>
    )
  } else if (r.type === 'more') {
    label = <span className="mute">+ {r.count} more in this job</span>
  } else if (r.type === 'hit') {
    icon = <Globe size={13} />
    label = r.hit.name
    hint = r.hit.endpoint
    aside = <span className="fal-tag">not curated</span>
  } else if (r.type === 'custom') {
    icon = <Globe size={13} />
    label = <span className="mono">{r.endpoint}</span>
    hint = 'Use this endpoint id (raw schema form)'
    aside = <span className="fal-tag">not curated</span>
  } else {
    icon = <Search size={13} />
    label = searching ? 'Searching every FAL model…' : 'Search all FAL models'
    hint = 'Tab'
  }
  return (
    <button className={cx('fal-pick-row', on && 'on', current && 'current', r.type === 'more' && 'more')} onMouseMove={onHover} onClick={onClick}>
      <span className="fal-pick-ico">{icon}</span>
      <span className="fal-pick-text">
        <span className="fal-pick-name">{label}</span>
        {hint && <span className="fal-pick-hint">{hint}</span>}
      </span>
      <span className="fal-pick-aside">{aside}</span>
    </button>
  )
}
