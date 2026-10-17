import { useEffect, useState } from 'react'
import { Archive, Check, Save } from 'lucide-react'
import type { MemoryFile, MemoryReport } from '@shared/api'
import { api, errText, op, toast } from '../store'
import { Confirm, Tabs } from './ui'
import { SettingsTitle } from './SettingsTitle'

/** The memory files Genio reads at session start. `lore` stays the stored id and file name. */
export const MEMORY_FILES: { id: MemoryFile; file: string; label: string }[] = [
  { id: 'player', file: 'player.md', label: 'Player profile' },
  { id: 'lore', file: 'lore.md', label: 'Squad memory' },
  { id: 'player-shared', file: 'player-shared.md', label: 'Shared profile' }
]

const ARCHIVE_REASON = 'Expired; archived by the player from Memory settings'

/** Settings → Memory: edit the memory files, archive expired entries, and see when memory is over its size budget. */
export function Memory({ budget }: { budget: number }) {
  const [file, setFile] = useState<MemoryFile>('player')
  const [text, setText] = useState('')
  const [orig, setOrig] = useState('')
  const [rev, setRev] = useState(0)
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

  const stale = report?.stale ?? []

  return (
    <>
      <SettingsTitle page="memory">
        <button
          className="btn sm solid"
          style={{ marginLeft: 'auto' }}
          onClick={() => void op('Curate now', () => api().save(), () => 'Genio is curating your profile and squad memory')}
        >
          <Save size={12} /> Curate now
        </button>
      </SettingsTitle>

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
            <button className="btn sm solid" disabled={!dirty} onClick={() => void write()}>
              <Check size={12} /> Save file
            </button>
          </div>
        </div>
        {loading ? (
          <div className="bar indeterminate">
            <i />
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

      {report && report.tokens > budget && <div className="alert-text memory-size">~{report.tokens} tok · over budget</div>}

      {stale.length > 0 && (
        <>
          <div className="label memory-label">
            Expired entries
            <button className="btn sm ghost" disabled={dirty} title={dirty ? 'Save or discard your edits first' : undefined} onClick={() => setConfirmAll(true)}>
              <Archive size={11} /> Archive all
            </button>
          </div>
          <div className="memory-stale">
            {stale.map((entry) => (
              <div key={entry} className="memory-stale-row">
                <span className="mono selectable">{entry}</span>
                <button className="btn sm ghost" disabled={dirty} title={dirty ? 'Save or discard your edits first' : undefined} onClick={() => void archive([entry])}>
                  <Archive size={11} /> Archive
                </button>
              </div>
            ))}
          </div>
        </>
      )}

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
