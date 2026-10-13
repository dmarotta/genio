import { useEffect, useState } from 'react'
import { Archive, Check, Eye, Pencil, RefreshCw, Save } from 'lucide-react'
import type { MemoryFile, MemoryReport } from '@shared/api'
import { api, errText, op, toast } from '../store'
import { Markdown } from './Markdown'
import { Confirm, Tabs } from './ui'
import { cx } from '../lib/format'

/** The memory files Genio reads at session start. `lore` stays the stored id and file name. */
export const MEMORY_FILES: { id: MemoryFile; file: string; label: string; hint: string }[] = [
  { id: 'player', file: 'player.md', label: 'Player profile', hint: 'How you like to work. Genio reads this at every session start.' },
  { id: 'lore', file: 'lore.md', label: 'Squad memory', hint: 'Curated squad knowledge. <!--P--> pinned · <!--a:DATE--> aging (30 days) · <!--p:DATE--> perishable (7 days)' },
  { id: 'player-shared', file: 'player-shared.md', label: 'Shared profile', hint: 'Inherited by every ally base.' }
]

const ARCHIVE_REASON = 'Expired; archived by the player from Memory settings'
const label = (file: string): string => MEMORY_FILES.find((f) => f.file === file)?.label ?? file

/** Settings → Memory: edit the memory files, see their size against the budget, archive expired entries. */
export function Memory({ budget }: { budget: number }) {
  const [file, setFile] = useState<MemoryFile>('player')
  const [text, setText] = useState('')
  const [orig, setOrig] = useState('')
  const [rev, setRev] = useState(0)
  const [preview, setPreview] = useState(false)
  const [loading, setLoading] = useState(true)
  const [report, setReport] = useState<MemoryReport | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)
  const dirty = text !== orig

  const loadReport = (): void => {
    void api()
      .memoryReport()
      .then(setReport)
      .catch((e) => toast('error', 'Could not measure memory', errText(e)))
  }
  useEffect(loadReport, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    void api()
      .readMemory(file)
      .then((t) => {
        if (!alive) return
        setText(t)
        setOrig(t)
      })
      .catch((e) => toast('error', 'Could not read', errText(e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [file, rev])

  const write = async (): Promise<void> => {
    // writeMemory resolves void; map success to true so op()'s undefined means failure
    const r = await op('Saved', () => api().writeMemory(file, text).then(() => true), () => MEMORY_FILES.find((f) => f.id === file)?.label)
    if (r) {
      setOrig(text)
      loadReport()
    }
  }

  const archive = async (entries: string[]): Promise<void> => {
    const r = await op('Archived', () => api().memoryArchive(entries, ARCHIVE_REASON).then(() => true), () => `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} moved to the memory archive`)
    if (!r) return
    loadReport()
    setRev((n) => n + 1)
  }

  const tokens = Math.round(text.length / 4)
  const stale = report?.stale ?? []

  return (
    <>
      <h2 className="sys-title">
        Memory
        <button
          className="btn sm solid"
          style={{ marginLeft: 'auto' }}
          onClick={() => void op('Save game', () => api().save(), () => 'Genio is curating your profile and squad memory')}
          title="Genio sweeps the session for durable knowledge, archives expired entries and enforces the budget"
        >
          <Save size={12} /> /save
        </button>
      </h2>
      <p className="mute">What Genio remembers between sessions. It reads these files at every session start and curates them on /save.</p>

      <section className="memory-editor">
        <div className="memory-top">
          <Tabs<MemoryFile>
            value={file}
            onChange={(f) => {
              if (dirty && !window.confirm('Discard unsaved changes?')) return
              setFile(f)
            }}
            tabs={MEMORY_FILES.map((f) => ({ id: f.id, label: f.label }))}
          />
          <div className="memory-tools">
            <span className={cx('mono', tokens > budget ? 'alert-text' : 'mute')} title="Estimated tokens vs startup memory budget">
              ~{tokens} tok
            </span>
            <button className={cx('btn sm ghost', preview && 'on')} onClick={() => setPreview((p) => !p)}>
              {preview ? <Pencil size={12} /> : <Eye size={12} />} {preview ? 'Edit' : 'Preview'}
            </button>
            <button className="btn sm solid" disabled={!dirty} onClick={() => void write()}>
              <Check size={12} /> Save file
            </button>
          </div>
        </div>
        <div className="mute memory-hint">{MEMORY_FILES.find((f) => f.id === file)?.hint}</div>
        {loading ? (
          <div className="bar indeterminate">
            <i />
          </div>
        ) : preview ? (
          <div className="memory-preview">
            <Markdown text={text} />
          </div>
        ) : (
          <textarea
            className="textarea mono memory-text"
            aria-label={`${MEMORY_FILES.find((f) => f.id === file)?.label} text`}
            value={text}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                void write()
              }
            }}
          />
        )}
      </section>

      <div className="label memory-label">
        Size
        <button className="btn sm ghost" onClick={loadReport} title="Measure again">
          <RefreshCw size={11} /> Refresh
        </button>
      </div>
      {report ? (
        <div className="memory-size mono">
          {report.files.map((f) => (
            <div key={f.file}>
              <span>{label(f.file)}</span>
              <span className="mute">{f.file}</span>
              <span>~{f.tokens} tok</span>
            </div>
          ))}
          <div className="memory-total">
            <span>Total</span>
            <span className="mute">budget {budget}</span>
            <span className={cx(report.tokens > budget && 'alert-text')}>~{report.tokens} tok{report.tokens > budget ? ' · over budget' : ''}</span>
          </div>
        </div>
      ) : (
        <div className="mute">Measuring…</div>
      )}

      <div className="label memory-label">
        Expired entries
        <button className="btn sm ghost" disabled={!stale.length || dirty} title={dirty ? 'Save or discard your edits first' : 'Move every expired entry to the archive'} onClick={() => setConfirmAll(true)}>
          <Archive size={11} /> Archive all
        </button>
      </div>
      {stale.length === 0 ? (
        <div className="mute">Nothing expired. Aging entries expire after 30 days, perishable ones after 7.</div>
      ) : (
        <div className="memory-stale">
          {stale.map((entry) => (
            <div key={entry} className="memory-stale-row">
              <span className="mono selectable">{entry}</span>
              <button className="btn sm ghost" disabled={dirty} title={dirty ? 'Save or discard your edits first' : 'Move this entry to the archive'} onClick={() => void archive([entry])}>
                <Archive size={11} /> Archive
              </button>
            </div>
          ))}
        </div>
      )}
      <p className="mute memory-hint">Archived entries move to memory-archive.md with the date and a reason; Genio stops loading them at session start.</p>

      {confirmAll && (
        <Confirm
          title={`Archive ${stale.length} expired entr${stale.length === 1 ? 'y' : 'ies'}?`}
          tone="amber"
          confirmLabel="Archive"
          body="They leave the memory files and move to memory-archive.md, where you can still read them."
          onConfirm={() => archive(stale)}
          onClose={() => setConfirmAll(false)}
        />
      )}
    </>
  )
}
