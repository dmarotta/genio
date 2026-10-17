import { useEffect, useState } from 'react'
import { Check, ImageOff, X } from 'lucide-react'
import { ART_BIBLE_MAX_BYTES, ART_BIBLE_WARN_BYTES, hasArtBible, paletteStrip, refLabel, type ArtBibleColor, type ArtBibleFile, type ArtBibleOverview, type ArtBibleRef, type ArtBibleView } from '@shared/art-bible'
import { PROJECT_WINDOW, api, errText, op, useStore } from '../store'
import { Markdown } from '../components/Markdown'
import { MarkdownEditor } from '../components/MarkdownEditor'
import { Tabs } from '../components/ui'
import { useScreenContext } from '../lib/screen-context'
import '../styles/art-bible.css'

type Tab = 'overview' | 'markdown'
export const ART_BIBLE_EMPTY = 'No Art Bible yet. Ask Genio to create one.'
/** Genio's chat or a unit may write the file while the screen is open. */
const POLL_MS = 3000
/** Unsaved Markdown edits per project, kept while the player visits other screens. */
const drafts = new Map<string, Partial<Record<ArtBibleFile, string>>>()

/** Each project window is bound to one project; the Art Bible is that project's `.genio/art-bible.md`. */
export function ArtBible() {
  const project = useStore(s => s.snap.projects.find(p => p.name === PROJECT_WINDOW))
  return (
    <div className="view art-bible">
      {project ? <WorldArtBible key={project.name} world={project.name} /> : <><Head /><p className="dim">Open this project from the Hub to see its Art Bible.</p></>}
    </div>
  )
}

function Head() {
  return (
    <header className="view-head ab-head">
      <h1 className="title">Art <span className="accent">Bible</span></h1>
    </header>
  )
}

function WorldArtBible({ world }: { world: string }) {
  const [view, setView] = useState<ArtBibleView>()
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('overview')
  const [, setRev] = useState(0)

  useEffect(() => {
    let alive = true, last = ''
    const load = (): void => {
      void api().artBibleRead(world).then(v => {
        if (!alive) return
        const key = JSON.stringify(v)
        if (key !== last) { last = key; setView(v) }
        setError('')
      }).catch(e => { if (alive) setError(errText(e)) })
    }
    load()
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load() }, POLL_MS)
    window.addEventListener('focus', load)
    return () => { alive = false; clearInterval(timer); window.removeEventListener('focus', load) }
  }, [world])

  const shown = hasArtBible(view)
  useScreenContext('art-bible', {
    world,
    facts: [
      view && { label: 'Art Bible', value: shown ? `${view.path}${view.source ? `, extending ${view.source.path}` : ''}` : 'none yet' },
      shown && { label: 'Tab', value: tab === 'overview' ? 'Overview' : 'Markdown' }
    ]
  })

  const setDraft = (file: ArtBibleFile, text: string | undefined): void => {
    const d = { ...drafts.get(world) }
    if (text === undefined) delete d[file]
    else d[file] = text
    drafts.set(world, d)
    setRev(n => n + 1)
  }

  if (!view) return <><Head />{error && <p className="alert-text">{error}</p>}</>
  if (!shown) return <><Head /><p className="dim ab-empty">{ART_BIBLE_EMPTY}</p></>

  return (
    <>
      <Head />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: 'overview', label: 'Overview' }, { id: 'markdown', label: 'Markdown' }]} />
      {error && <p className="alert-text">{error}</p>}
      {tab === 'overview'
        ? <Overview view={view} />
        : <MarkdownTab world={world} view={view} drafts={drafts.get(world) ?? {}} setDraft={setDraft} onSaved={setView} />}
    </>
  )
}

function Overview({ view }: { view: ArtBibleView }) {
  const b = view.bible
  if (!b) return <p className="alert-text">{view.error ?? 'This Art Bible could not be read.'}</p>
  const strip = paletteStrip(b)
  const empty = !b.style && !strip.length && !b.references.length && !b.do.length && !b.dont.length && !b.avoid.length
  return (
    <>
      {b.issues.length > 0 && <Issues issues={b.issues} />}
      {empty && <p className="dim">This Art Bible is empty.</p>}
      <div className="ab-grid">
        <div className="ab-col">
          {b.style && (
            <section className="panel ab-card">
              <div className="label ab-card-head">Style</div>
              <Markdown className="ab-style" text={b.style.text || b.style.summary} />
            </section>
          )}
          {b.references.length > 0 && (
            <section className="panel ab-card">
              <div className="label ab-card-head">Moodboard</div>
              <div className="ab-mood">{b.references.map((r, i) => <RefTile key={`${r.href}-${i}`} r={r} />)}</div>
            </section>
          )}
          {(b.do.length > 0 || b.dont.length > 0) && (
            <div className="ab-dd">
              {b.do.length > 0 && <Lines title="Do" lines={b.do} good />}
              {b.dont.length > 0 && <Lines title="Don't" lines={b.dont} />}
            </div>
          )}
        </div>
        {(strip.length > 0 || b.avoid.length > 0) && (
          <div className="ab-col">
            {strip.length > 0 && (
              <section className="panel ab-card">
                <div className="label ab-card-head">Palette</div>
                <Swatches colors={b.palette} />
                {b.accents.length > 0 && <><div className="label ab-sub">Accents</div><Swatches colors={b.accents} /></>}
              </section>
            )}
            {b.avoid.length > 0 && (
              <section className="panel ab-card">
                <div className="label ab-card-head">Avoid</div>
                <div className="ab-avoid">{b.avoid.map(a => <span key={a} className="chip alert">{a}</span>)}</div>
              </section>
            )}
          </div>
        )}
      </div>
    </>
  )
}

function Issues({ issues }: { issues: ArtBibleOverview['issues'] }) {
  return (
    <ul className="ab-issues">
      {issues.map((i, n) => <li key={n} className={i.level === 'error' ? 'alert-text' : 'amber-text'}>{i.message}</li>)}
    </ul>
  )
}

function RefTile({ r }: { r: ArtBibleRef }) {
  const [broken, setBroken] = useState(false)
  const label = refLabel(r)
  const why = r.external ? 'External link: not shown and never sent' : !r.exists ? 'Missing file' : 'Cannot be shown'
  return (
    <figure className="ab-ref">
      {r.url && !broken
        ? <img src={r.url} alt={label} loading="lazy" draggable={false} onError={() => setBroken(true)} />
        : <div className="ab-ref-none"><ImageOff size={18} /><span>{why}</span></div>}
      <figcaption>{label}</figcaption>
    </figure>
  )
}

function Lines({ title, lines, good }: { title: string; lines: string[]; good?: boolean }) {
  const Icon = good ? Check : X
  return (
    <section className="panel ab-card">
      <div className="label ab-card-head">{title}</div>
      <ul className="ab-list">
        {lines.map((l, i) => <li key={i}><Icon size={14} className={good ? 'volt-text' : 'alert-text'} /><span>{l}</span></li>)}
      </ul>
    </section>
  )
}

function Swatches({ colors }: { colors: ArtBibleColor[] }) {
  return (
    <div className="ab-swatches">
      {colors.map((c, i) => (
        <div key={`${c.hex}-${i}`} className="ab-swatch">
          <b style={{ background: c.hex }} />
          <span>{c.name}<span className="mono">{c.hex}</span>{c.use && <span className="mute">{c.use}</span>}</span>
        </div>
      ))}
    </div>
  )
}

/** The raw files in the shared markdown editor: one textarea per file, preview, Ctrl+S, size against the limits. */
function MarkdownTab({ world, view, drafts, setDraft, onSaved }: {
  world: string
  view: ArtBibleView
  drafts: Partial<Record<ArtBibleFile, string>>
  setDraft: (file: ArtBibleFile, text: string | undefined) => void
  onSaved: (v: ArtBibleView) => void
}) {
  const [file, setFile] = useState<ArtBibleFile>('bible')
  const current: ArtBibleFile = file === 'source' && view.source ? 'source' : 'bible'
  const disk = (current === 'source' ? view.source?.text : view.text) ?? ''
  const text = drafts[current] ?? disk
  const dirty = text !== disk
  const path = current === 'source' ? view.source!.path : view.path

  const save = async (): Promise<void> => {
    if (!dirty) return
    const r = await op('Save Art Bible', () => api().artBibleWrite(world, current, text))
    if (!r) return
    setDraft(current, undefined)
    onSaved(r)
  }

  return (
    <MarkdownEditor
      className="ab-markdown"
      head={view.source
        ? <Tabs<ArtBibleFile> value={current} onChange={setFile} tabs={[
          { id: 'bible', label: view.path, badge: drafts.bible !== undefined && drafts.bible !== (view.text ?? '') ? 1 : undefined },
          { id: 'source', label: view.source.path, badge: drafts.source !== undefined && drafts.source !== view.source.text ? 1 : undefined }
        ]} />
        : undefined}
      label={`${path} text`}
      text={text}
      dirty={dirty}
      maxBytes={ART_BIBLE_MAX_BYTES}
      warnBytes={ART_BIBLE_WARN_BYTES}
      sizeTitle={`Warns above ${ART_BIBLE_WARN_BYTES / 1024} KB; above ${ART_BIBLE_MAX_BYTES / 1024} KB generators cannot use it`}
      onChange={t => setDraft(current, t)}
      onSave={() => void save()}
      onDiscard={() => setDraft(current, undefined)}
    />
  )
}
