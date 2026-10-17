import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Plus } from 'lucide-react'
import type { DesignChatInfo } from '@shared/types'
import { DESIGN_NOTE_MAX_BYTES, noteBody, type DesignNote } from '@shared/design-notes'
import { chatKey } from '@shared/chat'
import { PROJECT_WKSP, PROJECT_WINDOW, api, errText, loadDesignChats, setState, toast, useStore, type DesignOpen as Open } from '../store'
import { clearDraft } from '../drafts'
import { ChatPanel } from './Comms'
import { Markdown } from '../components/Markdown'
import { MarkdownEditor } from '../components/MarkdownEditor'
import { Popover } from '../components/Layer'
import { useScreenContext } from '../lib/screen-context'
import { cx } from '../lib/format'
import '../styles/design.css'

export const DESIGN_EMPTY = 'No design chats yet. Start one with New chat.'
/** A design chat saves notes while the screen is open; the player may edit them in the project too. */
const POLL_MS = 3000
/** Below this width the list becomes a picker in the header. */
const NARROW = '(max-width: 720px)'
const UNTITLED = 'New chat'

/** Unsaved note edits by note name, with the version they started from; kept while the player visits other screens. */
const noteDrafts = new Map<string, { text: string; since: string }>()

/**
 * Design: the project's design chats (thinking partners that start no work) and its design notes
 * (`.genio/design/`), in one list. A chat opens in the chat view with its model and effort; a note reads as
 * markdown, with Edit. Turning a note into work stays with Genio in the floating panel.
 */
export function Design() {
  if (!PROJECT_WKSP || !PROJECT_WINDOW) return null
  return <DesignScreen wksp={PROJECT_WKSP} world={PROJECT_WINDOW} />
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => !!window.matchMedia?.(NARROW).matches)
  useEffect(() => {
    const m = window.matchMedia?.(NARROW)
    if (!m) return
    const on = (): void => setNarrow(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return narrow
}

/** The notes, read every few seconds and on focus, like the Art Bible screen. */
function useNotes(world: string): [DesignNote[] | undefined, (n: DesignNote[]) => void] {
  const [notes, setNotes] = useState<DesignNote[]>()
  useEffect(() => {
    let alive = true, last = ''
    const load = (): void => {
      void api().designNotes(world).then(n => {
        if (!alive) return
        const key = JSON.stringify(n)
        if (key !== last) { last = key; setNotes(n) }
      }).catch(() => { if (alive) setNotes(n => n ?? []) })
    }
    load()
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load() }, POLL_MS)
    window.addEventListener('focus', load)
    return () => { alive = false; clearInterval(timer); window.removeEventListener('focus', load) }
  }, [world])
  return [notes, setNotes]
}

function DesignScreen({ wksp, world }: { wksp: string; world: string }) {
  const loaded = useStore(s => s.designChats)
  const [notes, setNotes] = useNotes(world)
  const picked = useStore(s => s.designOpen)
  const [picking, setPicking] = useState(false)
  const [menu, setMenu] = useState<string>()
  const [, setRev] = useState(0)
  const menuAnchor = useRef<HTMLElement | null>(null)
  const picker = useRef<HTMLButtonElement>(null)
  const narrow = useNarrow()

  useEffect(() => { void loadDesignChats() }, [])

  // newest first
  const chats = useMemo(() => [...(loaded ?? [])].reverse(), [loaded])
  const exists = (o: Open): boolean => o.kind === 'chat'
    ? !loaded || chats.some(c => c.id === o.id)
    : !notes || notes.some(n => n.name === o.name)
  const open: Open | undefined = picked && exists(picked) ? picked : chats[0] && { kind: 'chat', id: chats[0].id }
  const chat = open?.kind === 'chat' ? chats.find(c => c.id === open.id) : undefined
  const note = open?.kind === 'note' ? notes?.find(n => n.name === open.name) : undefined
  const title = chat ? chat.title || UNTITLED : note?.file

  useScreenContext('design', { world, facts: [title !== undefined && { label: chat ? 'Design chat' : 'Design note', value: title }] })

  const show = (o: Open): void => {
    setState({ designOpen: o })
    setPicking(false)
  }

  const newChat = async (): Promise<void> => {
    // an untouched chat is reused rather than piling up empty ones
    const blank = chats.find(c => !c.title)
    if (blank) return show({ kind: 'chat', id: blank.id })
    try {
      const c = await api().designChatCreate(wksp)
      setState(s => ({ designChats: s.designChats?.some(x => x.id === c.id) ? s.designChats : [...(s.designChats ?? []), c] }))
      show({ kind: 'chat', id: c.id })
    } catch (e) {
      toast('error', 'Chat not started', errText(e))
    }
  }

  const remove = async (id: string): Promise<void> => {
    setMenu(undefined)
    try {
      await api().designChatDelete(wksp, id)
      const key = chatKey(wksp, id)
      clearDraft(key)
      setState(s => {
        const rest = { ...s.chats }
        delete rest[key]
        return { designChats: s.designChats?.filter(c => c.id !== id), chats: rest }
      })
      if (open?.kind === 'chat' && open.id === id) setState({ designOpen: undefined })
    } catch (e) {
      toast('error', 'Chat not deleted', errText(e))
    }
  }

  const list = (
    <DesignList
      chats={chats}
      notes={notes ?? []}
      open={open}
      onOpen={show}
      onNew={() => void newChat()}
      onMenu={(id, el) => { menuAnchor.current = el; setMenu(id) }}
    />
  )

  const draft = note && noteDrafts.get(note.name)
  const edit = (): void => {
    if (!note) return
    noteDrafts.set(note.name, { text: note.text, since: note.version })
    setRev(n => n + 1)
  }
  const dropDraft = (name: string): void => {
    noteDrafts.delete(name)
    setRev(n => n + 1)
  }
  const save = async (): Promise<void> => {
    if (!note || !draft || draft.text === note.text) return
    try {
      setNotes(await api().designNoteWrite(world, note.name, draft.text, draft.since))
      dropDraft(note.name)
    } catch (e) {
      toast('error', 'Note not saved', errText(e))
    }
  }

  return (
    <div className={cx('design-view', narrow && 'narrow')}>
      {!narrow && (
        <aside className="design-list" aria-label="Design chats and notes">
          <h1 className="title">De<span className="accent">sign</span></h1>
          {list}
        </aside>
      )}
      <section className="design-main">
        {(narrow || (note && !draft)) && (
          <header className="design-head">
            {narrow && <button ref={picker} className="design-picker" aria-haspopup="dialog" aria-expanded={picking} onClick={() => setPicking(p => !p)}>
              <b>{title ?? 'Design'}</b><ChevronDown size={14} />
            </button>}
            {note && !draft && <button className="btn sm" onClick={edit}>Edit</button>}
          </header>
        )}
        {chat
          ? <ChatPanel key={chat.id} wksp={wksp} conversation={chat.id} />
          : note
            ? <div className="design-note">
              {draft
                ? <MarkdownEditor
                  label={`${note.file} text`}
                  text={draft.text}
                  dirty={draft.text !== note.text}
                  maxBytes={DESIGN_NOTE_MAX_BYTES}
                  sizeTitle={`Up to ${DESIGN_NOTE_MAX_BYTES / 1024} KB per note`}
                  onChange={t => { noteDrafts.set(note.name, { ...draft, text: t }); setRev(n => n + 1) }}
                  onSave={() => void save()}
                  onDiscard={() => dropDraft(note.name)}
                  onCancel={() => dropDraft(note.name)}
                />
                : <Markdown className="design-note-body" text={noteBody(note.text)} />}
            </div>
            : loaded && !chats.length && <p className="dim design-empty">{DESIGN_EMPTY}</p>}
      </section>
      {picking && (
        <Popover anchor={picker} placement="bottom-start" className="design-sheet panel" role="dialog" aria-label="Design chats and notes" onClose={() => setPicking(false)}>
          {list}
        </Popover>
      )}
      {menu && (
        <Popover anchor={menuAnchor} placement="bottom-start" className="unit-menu" role="menu" aria-label="Chat actions" onClose={() => setMenu(undefined)}>
          <button role="menuitem" className="unit-menu-item danger" autoFocus onClick={() => void remove(menu)}>
            <span className="umi-label">Delete chat</span>
          </button>
        </Popover>
      )}
    </div>
  )
}

/** New chat, then the chats (delete from the context menu), then the notes. */
function DesignList({ chats, notes, open, onOpen, onNew, onMenu }: {
  chats: DesignChatInfo[]
  notes: DesignNote[]
  open?: Open
  onOpen: (o: Open) => void
  onNew: () => void
  onMenu: (id: string, el: HTMLElement) => void
}) {
  return (
    <>
      <button className="btn sm design-new" onClick={onNew}><Plus size={13} /> New chat</button>
      {chats.length > 0 && (
        <div className="design-group" role="group" aria-label="Chats">
          <div className="label">Chats</div>
          {chats.map(c => {
            const on = open?.kind === 'chat' && open.id === c.id
            return (
              <button key={c.id} className={cx('design-item', on && 'on')} aria-current={on || undefined} title={c.title || undefined}
                onClick={() => onOpen({ kind: 'chat', id: c.id })}
                onContextMenu={e => { e.preventDefault(); onMenu(c.id, e.currentTarget) }}>
                {c.title || UNTITLED}
              </button>
            )
          })}
        </div>
      )}
      {notes.length > 0 && (
        <div className="design-group" role="group" aria-label="Notes">
          <div className="label">Notes</div>
          {notes.map(n => {
            const on = open?.kind === 'note' && open.name === n.name
            return (
              <button key={n.name} className={cx('design-item mono', on && 'on')} aria-current={on || undefined} onClick={() => onOpen({ kind: 'note', name: n.name })}>
                {n.file}
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}
