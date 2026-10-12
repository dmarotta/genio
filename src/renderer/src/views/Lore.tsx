import { useEffect, useState } from 'react'
import { Check, Eye, Mail, Pencil, Save, Send } from 'lucide-react'
import type { MemoryFile } from '@shared/api'
import { api, errText, op, toast, useStore } from '../store'
import { Markdown } from '../components/Markdown'
import { Tabs, ViewHeader } from '../components/ui'
import { clock, cx, dateShort } from '../lib/format'

const FILES: { id: MemoryFile; label: string; hint: string }[] = [
  { id: 'player', label: 'Player Profile', hint: 'How you like to play. Genio reads this at every session start.' },
  { id: 'lore', label: 'Lore', hint: 'Curated squad knowledge. <!--P--> pinned · <!--a:DATE--> aging · <!--p:DATE--> perishable' },
  { id: 'player-shared', label: 'Shared Profile', hint: 'Inherited by every ally base.' }
]

export function Lore() {
  const [file, setFile] = useState<MemoryFile>('player')
  const [text, setText] = useState('')
  const [orig, setOrig] = useState('')
  const [preview, setPreview] = useState(false)
  const [loading, setLoading] = useState(true)
  const budget = useStore((s) => s.settings?.memoryBudgetTokens ?? 7500)
  const dirty = text !== orig

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
  }, [file])

  const write = async (): Promise<void> => {
    const r = await op('Saved', () => api().writeMemory(file, text), () => FILES.find((f) => f.id === file)?.label)
    if (r !== undefined) setOrig(text)
  }

  const tokens = Math.round(text.length / 4)

  return (
    <div className="view">
      <ViewHeader
        kicker="Memory that survives every respawn"
        title={
          <>
            <span className="accent">Lore</span>
          </>
        }
      >
        <button className="btn solid" onClick={() => void op('Save game', () => api().save(), () => 'Genio is curating your profile and lore')} title="Genio sweeps the session for durable knowledge, decays stale entries and enforces the budget">
          <Save size={14} /> /save
        </button>
      </ViewHeader>
      <div className="lore-layout">
        <section className="lore-editor panel">
          <div className="lore-top">
            <Tabs<MemoryFile> value={file} onChange={(f) => {
              if (dirty && !window.confirm('Discard unsaved changes?')) return
              setFile(f)
            }} tabs={FILES.map((f) => ({ id: f.id, label: f.label }))} />
            <div className="lore-tools">
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
          <div className="mute lore-hint">{FILES.find((f) => f.id === file)?.hint}</div>
          {loading ? (
            <div className="bar indeterminate">
              <i />
            </div>
          ) : preview ? (
            <div className="lore-preview">
              <Markdown text={text} />
            </div>
          ) : (
            <textarea
              className="textarea mono lore-text"
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
        <MailPanel />
      </div>
    </div>
  )
}

function MailPanel() {
  const notes = useStore((s) => s.snap.inbox)
  const settings = useStore((s) => s.settings)
  const [text, setText] = useState('')
  const sorted = [...notes].sort((a, b) => b.ts.localeCompare(a.ts))
  return (
    <aside className="mail panel">
      <header className="card-head">
        <span className="label">
          <Mail size={12} style={{ verticalAlign: -2 }} /> Mail
        </span>
        <span className="mute" style={{ fontSize: 11 }}>
          {settings?.inboxServer ? `HTTP intake on :${settings.inboxPort}` : 'HTTP intake off'}
        </span>
      </header>
      <div className="mail-compose">
        <textarea className="textarea" rows={3} value={text} placeholder="Leave Genio a note — it picks it up on the next event." onChange={(e) => setText(e.target.value)} />
        <button
          className="btn sm solid"
          disabled={!text.trim()}
          onClick={async () => {
            const r = await op('Mail sent', () => api().inboxSubmit(text.trim(), settings?.gamertag || 'Player'), () => 'Genio will read it next')
            if (r) setText('')
          }}
        >
          <Send size={12} /> Send
        </button>
      </div>
      <div className="mail-list">
        {sorted.length === 0 && <div className="mute side-empty">No mail.</div>}
        {sorted.map((n) => (
          <div key={n.id} className={cx('mail-note', !n.ackedAt && 'unread')}>
            <div className="mail-meta">
              <b>{n.from}</b>
              <span className="mono mute">
                {dateShort(n.ts)} {clock(n.ts)}
              </span>
              {!n.ackedAt ? (
                <button className="btn sm ghost" onClick={() => void op('Mail', () => api().inboxAck(n.id))}>
                  Ack
                </button>
              ) : (
                <span className="chip volt">read</span>
              )}
            </div>
            <div className="mail-text selectable">{n.text}</div>
            {n.reply && (
              <div className="mail-reply selectable">
                <span className="label neon-text">Genio</span> {n.reply}
              </div>
            )}
          </div>
        ))}
      </div>
    </aside>
  )
}
