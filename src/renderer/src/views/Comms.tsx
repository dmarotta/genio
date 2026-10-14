import { ASSISTANT_NAME } from '@shared/assistant'
import { ComingNext } from '../components/ComingNext'
import { GenerationCard } from '../components/GenerationCard'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { ArrowDown, ChevronDown, ChevronRight, CircleStop, Pencil, RefreshCw, Rocket, Send, ShieldCheck, TriangleAlert, Wrench, X } from 'lucide-react'
import type { Ally, ChatMessage, Settings } from '@shared/types'
import { chatControls, routedRequest, splitQueued, type ChatControls, type UnqueuedChat } from '@shared/chat'
import { MAX_IMAGES_PER_MESSAGE } from '@shared/chat-images'
import {
  PROJECT_WKSP, api, errText, focusTask, getState, go, loadChat, op, openDeploy, saveChatControls, saveSettings, setState, toast, useStore
} from '../store'
import { Markdown } from '../components/Markdown'
import { CopyMessageButton } from '../components/CopyMessageButton'
import { GenioCore } from '../components/GenioCore'
import { Chip, Dot, Toggle } from '../components/ui'
import { Roster } from '../components/SquadPanel'
import { clock, cx, trunc } from '../lib/format'
import { playSfx } from '../lib/sfx'
import { getDraft, setDraft } from '../drafts'
import { AttachmentStrip, GeneratingImages, MessageImages, fromSendable, toSendable, useAttachments } from '../components/ChatImages'
import type { InventoryContext } from '@shared/inventory-context'
import { InventoryContextChips, useInventoryContext } from '../components/InventoryContextChips'
const MAIN_PANEL = 'main'
import { EffortSelect, ModelSelect, requestSystemsSection } from './Systems'

const SLASH: { cmd: string; hint: string }[] = [
  { cmd: '/recap', hint: 'Previously on… then your pending moves, one at a time' },
  { cmd: '/status', hint: 'Character Sheet: level, XP & achievements' },
  { cmd: '/deploy', hint: 'Open the Deploy panel' },
  { cmd: '/afk', hint: 'Go AFK — the Bot plays, outcomes replay on return' },
  { cmd: '/dnd', hint: 'Do not disturb — routine events stay off-screen' },
  { cmd: '/online', hint: 'Back online — everything reported here' },
  { cmd: '/save', hint: 'Curate player profile & squad memory (save game)' },
  { cmd: '/patch', hint: 'Check for a Genio update' },
  { cmd: '/help', hint: 'List commands' }
]

const NOOP_RE = /^\s*(all clear|gg,? all clear)\b/i

export function Comms() {
  if (!PROJECT_WKSP) return null

  return (
    <div className="comms">
      <section className="comms-main">
        <ChatPanel wksp={PROJECT_WKSP} />
      </section>

      <aside className="comms-side">
        <Roster />
      </aside>
    </div>
  )
}

/** The project chat: its own status bar, log and composer. */
export function ChatPanel({ wksp, context, surface = 'screen', active: _active = true }: { wksp: string; context?: InventoryContext; surface?: 'screen' | 'panel'; active?: boolean }) {
  const info = useStore((s) => s.snap.wksps.find((m) => m.name === wksp))
  const messages = useStore((s) => s.chats[wksp] ?? [])
  const settings = useStore((s) => s.settings)
  const gamertag = settings?.gamertag || 'Player'
  const calm = !!settings?.calm
  const busy = info?.activity === 'thinking' || info?.activity === 'tool' || info?.activity === 'starting'
  const isAlly = wksp !== MAIN_PANEL

  useEffect(() => {
    void loadChat(wksp)
  }, [wksp])

  const visible = useMemo(() => (calm ? messages.filter((m) => !calmHidden(m)) : messages), [messages, calm])

  // Edit / cancel a message the session has not picked up yet; edit puts it back in this chat's composer.
  // Stable across renders so memoised messages are not re-rendered by every streamed token.
  const fill = useRef<((c: UnqueuedChat) => void) | undefined>(undefined)
  const takeBack = useCallback(async (m: ChatMessage, edit: boolean): Promise<void> => {
    try {
      const got = await api().unqueueChat(wksp, m.id)
      if (!got) toast('info', 'Already sent', `${ASSISTANT_NAME} picked that message up before it could be changed.`)
      else if (edit) fill.current?.(got)
    } catch (e) {
      toast('error', edit ? 'Message not editable' : 'Message not cancelled', errText(e))
    }
  }, [wksp])

  return (
    <div className="chat-panel">
      <header className="comms-head">
        <div className="chat-title">
          <span className="label neon-text">{ASSISTANT_NAME}</span>
        </div>
        <div className="comms-status">
          <span className={cx('activity', info?.activity)}>
            <Dot tone={info?.activity === 'error' ? 'alert' : busy ? 'neon' : info?.activity === 'offline' ? 'mute' : 'volt'} pulse={busy} />
            {activityText(info?.activity, info?.activityDetail)}
          </span>
          {!isAlly && <ComingNext />}
          {info?.queued ? <Chip tone="amber">{info.queued} queued</Chip> : null}
          <Toggle checked={calm} onChange={(v) => void saveSettings({ calm: v })} label={<span className="label">Clean HUD</span>} />
          {busy && (
            <button className="btn sm alert" onClick={() => void op('Interrupt', () => api().interruptWksp(wksp))}>
              <CircleStop size={13} /> Interrupt
            </button>
          )}
          <button
            className="btn sm ghost icon"
            title="Restart session (keeps memory; shift-click for a fresh session)"
            onClick={(e) => void op('Restart', () => api().restartWksp(wksp, e.shiftKey), () => (e.shiftKey ? 'Fresh session' : 'Session resumed'))}
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </header>

      {(['genio', 'bot'] as const).map(role => {
        const limit = role === 'bot' ? info?.botLimit : info?.limit
        if (!limit) return null
        return <div className="chat-limit" role="status" key={role}>
          <span>{role === 'bot' ? 'Bot: ' : ''}{limit.provider === 'codex' ? `${limit.reason || 'Codex unavailable'} Open Accounts, then resume the session.` : limit.reason || (limit.restartRequired
            ? 'Claude still reports an expired limit. Restart the session to try again.'
            : `Claude limit reached${limit.resetsAt ? ` ? back at ${new Date(limit.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ' ? waiting for reset'}`)}</span>
          {limit.provider === 'codex' && <button className="btn sm" onClick={() => requestSystemsSection('accounts')}>Accounts</button>}
          {!limit.restartRequired && <button className="btn sm" onClick={() => void op('Retry', () => api().restartWksp(wksp, false, role))}>Retry now</button>}
          <button className="btn sm ghost" onClick={() => void op('Restart', () => api().restartWksp(wksp, false, role))}>Restart session</button>
        </div>
      })}

      <ChatLog key={wksp} wksp={wksp} surface={surface} messages={visible} calm={calm} busy={busy} gamertag={gamertag} activityDetail={info?.activityDetail} lastError={info?.lastError} onTakeBack={takeBack} />

      <Composer wksp={wksp} busy={busy} fill={fill} context={context} />
    </div>
  )
}

function activityText(a?: string, detail?: string): string {
  switch (a) {
    case 'thinking':
      return 'Thinking'
    case 'tool':
      return detail ? trunc(detail, 28) : 'Working'
    case 'starting':
      return 'Linking'
    case 'error':
      return 'Error'
    case 'offline':
      return 'Standby'
    default:
      return 'Ready'
  }
}

/**
 * Clean HUD drops wakes and any Genio turn with nothing left to show once tool traces are hidden
 * (tool-only turns, empty partials), header and timestamp included, so no bare headers stack up.
 */
function calmHidden(m: ChatMessage): boolean {
  if (m.role === 'wake') return true
  return m.role === 'genio' && !m.text.trim() && !m.generation && !m.generating && !m.images?.length
}

type TakeBack = (m: ChatMessage, edit: boolean) => Promise<void>

/**
 * Where the player left each chat scrolled up (first visible message and its offset), keyed by
 * chat and surface. Screens remount on every switch, so this is what lets returning to a chat land
 * where it was left; no entry means "following the latest message".
 */
const scrollMemory = new Map<string, { id: string; offset: number }>()
const NEAR_BOTTOM = 80
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '])

/** The first message at or below the top edge of the log, with its distance from that edge. */
function topMessage(el: HTMLElement): { id: string; offset: number } | undefined {
  const top = el.getBoundingClientRect().top
  for (const node of el.querySelectorAll<HTMLElement>('[data-msg]')) {
    const r = node.getBoundingClientRect()
    if (r.bottom > top) return { id: node.dataset.msg!, offset: r.top - top }
  }
  return undefined
}

function ChatLog({ wksp, surface, messages: all, calm, busy, gamertag, activityDetail, lastError, onTakeBack }: { wksp: string; surface: string; messages: ChatMessage[]; calm: boolean; busy: boolean; gamertag: string; activityDetail?: string; lastError?: string; onTakeBack: TakeBack }) {
  const ref = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const memoryKey = `${wksp}:${surface}`
  // Follow the latest message unless the player scrolled up by hand. Off-screen messages are laid
  // out late (content-visibility), so the bottom keeps moving after a scroll: only wheel, touch,
  // keys or a scrollbar drag count as the player leaving it, never a scroll caused by layout.
  const follow = useRef(!scrollMemory.has(memoryKey))
  const [following, setFollowing] = useState(follow.current)
  const intent = useRef({ at: -Infinity, dragging: false })
  const jumping = useRef(false)
  const setFollow = useCallback((v: boolean) => { follow.current = v; setFollowing(v) }, [])
  const pin = useCallback(() => {
    const el = ref.current
    if (el && follow.current && !jumping.current) el.scrollTop = el.scrollHeight
  }, [])
  const finishJump = useCallback(() => {
    if (!jumping.current) return
    jumping.current = false
    pin()
  }, [pin])
  const jumpToLatest = useCallback(() => {
    const el = ref.current
    if (!el) return
    // The click supersedes the wheel/key/drag that left us above the bottom. Otherwise a scroll
    // event from late content-visibility layout can interpret that old intent as a new scroll-up.
    intent.current = { at: -Infinity, dragging: false }
    setFollow(true)
    scrollMemory.delete(memoryKey)
    jumping.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 1) finishJump()
  }, [memoryKey, setFollow, finishJump])
  // queued messages wait under everything else, in send order, until the session picks them up
  const { log: messages, queued } = useMemo(() => splitQueued(all), [all])

  useLayoutEffect(() => {
    const el = ref.current!
    const saved = scrollMemory.get(memoryKey)
    const anchor = saved && [...el.querySelectorAll<HTMLElement>('[data-msg]')].find((n) => n.dataset.msg === saved.id)
    if (anchor) el.scrollTop += anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - saved!.offset
    else if (saved) setFollow(true)
    // Re-pin while late layout, late history or a resize moves the bottom, as long as the player follows it.
    const ro = new ResizeObserver(pin)
    ro.observe(el)
    if (body.current) ro.observe(body.current)
    const key = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (SCROLL_KEYS.has(e.key) && !t?.closest?.('input, textarea, select, [contenteditable="true"]')) {
        intent.current.at = performance.now()
        jumping.current = false
      }
    }
    const release = (): void => { intent.current.dragging = false }
    const view = el.ownerDocument.defaultView ?? window
    view.addEventListener('keydown', key)
    view.addEventListener('pointerup', release)
    view.addEventListener('pointercancel', release)
    // Do not snap each intermediate smooth-scroll event. Once it ends, catch the actual bottom
    // (which may have grown since the click), then let the observer keep following late layout.
    el.addEventListener('scrollend', finishJump)
    return () => {
      ro.disconnect()
      el.removeEventListener('scrollend', finishJump)
      view.removeEventListener('keydown', key)
      view.removeEventListener('pointerup', release)
      view.removeEventListener('pointercancel', release)
      // Remember a deliberate scroll-up for the next mount; a hidden log has no geometry to read.
      if (follow.current) scrollMemory.delete(memoryKey)
      else if (el.clientHeight > 0) {
        const at = topMessage(el)
        if (at) scrollMemory.set(memoryKey, at)
      }
    }
  }, [memoryKey, pin, setFollow, finishJump])

  useLayoutEffect(pin, [all, busy, pin])

  const markIntent = (): void => { intent.current.at = performance.now(); jumping.current = false }
  return (
    <div
      className="chat-log"
      ref={ref}
      onWheel={markIntent}
      onTouchMove={markIntent}
      onPointerDown={() => { intent.current.dragging = true; jumping.current = false }}
      onScroll={(e) => {
        const el = e.currentTarget
        if (el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM) { if (!follow.current) setFollow(true) }
        else if (intent.current.dragging || performance.now() - intent.current.at < 600) { if (follow.current) setFollow(false) }
        else pin()
      }}
    >
      <div className="chat-log-body" ref={body}>
        {all.length === 0 && wksp !== MAIN_PANEL && (
          <div className="chat-empty rise">
            <GenioCore size={80} state={busy ? 'active' : 'idle'} />
            <h2 className="title" style={{ fontSize: 24 }}>
              {ASSISTANT_NAME}
            </h2>
            <p className="dim">Tell Genio what to build in this project. Your conversation and controls stay with this window.</p>
          </div>
        )}
        {all.length === 0 && wksp === MAIN_PANEL && (
          <div className="chat-empty rise">
            <GenioCore size={110} state={busy ? 'active' : 'idle'} />
            <h2 className="title" style={{ fontSize: 30 }}>
              Ready, <span className="accent">{gamertag}</span>
            </h2>
            <p className="dim">Tell Genio what to build. It deploys units, watches them, and only pings you for real choices.</p>
            <div className="quick-chips">
              <button className="btn" onClick={() => void op('Recap', () => api().recap())}>
                Recap
              </button>
              <button className="btn" onClick={() => go('status')}>
                Character Sheet
              </button>
              <button className="btn solid" onClick={() => openDeploy()}>
                <Rocket size={14} /> Deploy
              </button>
            </div>
          </div>
        )}
        {messages.map((m) => (
          <Message key={m.id} m={m} calm={calm} gamertag={gamertag} onTakeBack={onTakeBack} />
        ))}
        {busy && (
          <div className="msg genio working rise">
            <div className="msg-avatar">
              <GenioCore size={34} state="active" />
            </div>
            <div className="working-line">
              <span className="working-text">{activityDetail ? trunc(activityDetail, 60) : `${ASSISTANT_NAME} is on it`}</span>
              <span className="working-dots">
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
        )}
        {lastError && !busy && <div className="msg-error mono">{lastError} <button className="btn sm" onClick={() => void op('Restart', () => api().restartWksp(wksp, false))}>Restart session</button></div>}
        {queued.map((m) => (
          <Message key={m.id} m={m} calm={calm} gamertag={gamertag} onTakeBack={onTakeBack} />
        ))}
      </div>
      {!following && (
        <div className="chat-jump-dock">
          <button className="btn sm chat-jump" onClick={jumpToLatest}>
            <ArrowDown size={13} /> Jump to latest
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * One message. Memoised: a streamed delta replaces only the message it belongs to, so the
 * other messages of a long transcript keep their rendered output (and parsed Markdown).
 */
const Message = memo(function Message({ m, calm, gamertag, onTakeBack }: { m: ChatMessage; calm: boolean; gamertag: string; onTakeBack: TakeBack }) {
  const [open, setOpen] = useState(false)
  if (m.role === 'player') {
    const waiting = m.queue === 'queued' || m.queue === 'unsent'
    return (
      <div data-msg={m.id} className={cx('msg player rise', waiting && m.queue)}>
        {m.images?.length ? <MessageImages wksp={m.wksp} images={m.images.filter(i => i.file !== m.context?.thumbnail?.image?.file)} /> : null}
        {m.text && <div className="msg-bubble selectable">{m.text}</div>}
        <InventoryContextChips context={m.context} wksp={m.wksp} />
        <div className="msg-meta">
          {m.queue === 'queued' && (
            <span className="msg-queue" title="Sent while the session was busy: it reads this as soon as the current turn ends.">
              Queued ·{' '}
            </span>
          )}
          {m.queue === 'unsent' && (
            <span className="msg-queue" title="The session stopped (Genio or this project window closed) before reading this message. Edit to send it again.">
              Not sent ·{' '}
            </span>
          )}
          {gamertag} · {clock(m.ts)}
          <CopyMessageButton text={m.text} />
          {waiting && (
            <span className="msg-acts">
              <button className="msg-act" title="Edit: put it back in the composer" aria-label="Edit queued message" onClick={() => void onTakeBack(m, true)}>
                <Pencil size={11} />
              </button>
              <button className="msg-act" title={m.queue === 'queued' ? 'Cancel: remove it from the queue' : 'Remove'} aria-label="Cancel queued message" onClick={() => void onTakeBack(m, false)}>
                <X size={12} />
              </button>
            </span>
          )}
        </div>
      </div>
    )
  }
  if (m.role === 'wake') {
    return (
      <div data-msg={m.id} className="msg-wake mono" title={m.text}>
        <span className="msg-wake-text"><span className="neon-text">⚡</span> {trunc(m.text.split('\n')[0], 140)}
          <span className="mute"> · {clock(m.ts)}</span>
        </span>
        <CopyMessageButton text={m.text} />
      </div>
    )
  }
  const routed = m.wksp !== MAIN_PANEL ? routedRequest(m) : null
  if (routed) {
    return (
      <div data-msg={m.id} className="msg player from-genio rise">
        <div className="msg-from label neon-text">From Genio</div>
        <div className="msg-bubble selectable">
          <Markdown text={routed.text} />
        </div>
        <div className="msg-meta">
          {ASSISTANT_NAME} · {clock(m.ts)}
          {routed.corr ? ` · ${routed.corr}` : ''}
          <CopyMessageButton text={routed.text} />
        </div>
      </div>
    )
  }
  if (m.role === 'system') {
    return (
      <div data-msg={m.id} className="msg-system rise">
        <Markdown text={m.text} />
        <CopyMessageButton text={m.text} />
      </div>
    )
  }
  if (m.role === 'error') {
    return <div data-msg={m.id} className="msg-error mono selectable">{m.text}<CopyMessageButton text={m.text} /></div>
  }
  const noop = NOOP_RE.test(m.text) && m.text.length < 90
  const tools = m.tools ?? []
  return (
    <div data-msg={m.id} className={cx('msg genio rise', noop && 'noop', calm && noop && 'calm-noop')}>
      <div className="msg-avatar">
        <GenioCore size={34} state={m.partial ? 'active' : 'idle'} />
      </div>
      <div className="msg-content">
        {m.text && !m.generation && <Markdown text={m.text} className={m.partial ? 'streaming' : ''} />}
        {m.generation && <GenerationCard card={m.generation} wksp={m.wksp} />}
        {m.generating ? <GeneratingImages count={m.generating} /> : null}
        {m.images?.length ? <MessageImages wksp={m.wksp} images={m.images} /> : null}
        {!calm && tools.length > 0 && (
          <div className="tool-traces">
            <button className="tool-chip" onClick={() => setOpen((o) => !o)}>
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <Wrench size={11} /> used {tools.length} tool{tools.length > 1 ? 's' : ''}
              {tools.some((t) => t.isError) && <span className="alert-text"> · error</span>}
            </button>
            {open && (
              <div className="tool-list-inline">
                {tools.map((t) => (
                  <div key={t.id} className={cx('trace', t.isError && 'err')}>
                    <div className="trace-name mono">{t.name.replace(/^mcp__genio__/, '')}</div>
                    <pre className="trace-io selectable">{trunc(t.input, 600)}</pre>
                    {t.result && <pre className="trace-io result selectable">{trunc(t.result, 1200)}</pre>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="msg-meta">
          {ASSISTANT_NAME} · {clock(m.ts)}
          {m.costUsd ? ` · $${m.costUsd.toFixed(3)}` : ''}
          <CopyMessageButton text={m.text} />
        </div>
      </div>
    </div>
  )
})

function Composer({ wksp, busy, fill, context }: { wksp: string; busy: boolean; context?: InventoryContext; fill: RefObject<((c: UnqueuedChat) => void) | undefined> }) {
  // Client-side commands drive the whole app, so they live in the main chat; an ally gets its text (and its own /help, /status, /save) as typed.
  const isMain = wksp === MAIN_PANEL
  const [text, setText] = useState(() => getDraft(wksp))
  const [sel, setSel] = useState(0)
  const ta = useRef<HTMLTextAreaElement>(null)
  const att = useAttachments(wksp)
  const inventory = useInventoryContext(wksp, context)
  const canSend = !!text.trim() || att.images.length > 0
  // Recap runs as its own turn: hold it while one runs or messages wait, and when the chat cannot take a turn.
  const info = useStore((s) => s.snap.wksps.find((m) => m.name === wksp))
  const recapOff = !info || info.limit
    ? 'Chat unavailable'
    : busy || info.queued
      ? `${ASSISTANT_NAME} is working`
      : ''
  const update = (v: string): void => {
    setText(v)
    setDraft(wksp, v)
  }

  // Restore this chat's draft (on mount or chat switch) with the caret at the end.
  useLayoutEffect(() => {
    const d = getDraft(wksp)
    setText(d)
    const el = ta.current
    if (el && d) {
      el.value = d
      el.setSelectionRange(d.length, d.length)
    }
  }, [wksp])
  // A queued message taken back for editing: its text goes first (ahead of any draft), its images join the strip.
  useEffect(() => {
    fill.current = (c) => {
      inventory.restore(c.context)
      const draft = getDraft(wksp)
      const next = [c.text, draft].filter((s) => s.trim()).join('\n\n')
      update(next)
      if (c.images?.length) att.set([...fromSendable(c.images), ...att.images].slice(0, MAX_IMAGES_PER_MESSAGE))
      const el = ta.current
      if (el) {
        el.focus()
        requestAnimationFrame(() => el.setSelectionRange(next.length, next.length))
      }
    }
  })
  const settings = useStore((s) => s.settings)
  const showSlash = isMain && text.startsWith('/') && !text.includes(' ') && !text.includes('\n')
  const matches = showSlash ? SLASH.filter((s) => s.cmd.startsWith(text.toLowerCase())) : []

  useEffect(() => {
    const el = ta.current
    if (!el) return
    const fit = (): void => {
      el.style.height = 'auto'
      el.style.height = Math.min(220, el.scrollHeight) + 'px'
    }
    fit()
    // Floating/docked chat can change width without changing the draft text.
    let width = el.clientWidth
    const observer = new ResizeObserver(() => {
      if (width === el.clientWidth) return
      width = el.clientWidth
      fit()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [text, wksp])

  const localSystem = (t: string): void => {
    const s = getState()
    const msg: ChatMessage = { id: `local-${Date.now()}`, wksp, role: 'system', text: t, ts: new Date().toISOString() }
    setState({ chats: { ...s.chats, [wksp]: [...(s.chats[wksp] ?? []), msg] } })
  }

  const submit = async (raw: string): Promise<void> => {
    const t = raw.trim()
    const images = att.images
    if (!t && !images.length) return
    if (att.pending) {
      toast('info', 'Attaching images', 'Wait a moment for the images to finish attaching.')
      return
    }
    update('')
    const [cmd, ...rest] = t.split(/\s+/)
    const words = rest.join(' ')
    // with images attached, a leading slash is just text for Genio
    if (isMain && t.startsWith('/') && !images.length) {
      switch (cmd.toLowerCase()) {
        case '/recap':
          await op('Recap', () => api().recap())
          return
        case '/status':
          go('status')
          return
        case '/deploy':
          openDeploy()
          return
        case '/afk':
        case '/dnd':
        case '/online': {
          const mode = cmd.slice(1).toLowerCase() as 'afk' | 'dnd' | 'online'
          if (words) {
            try {
              await api().sendChat(wksp, `Heading ${mode.toUpperCase()}: ${words}`)
            } catch {
              /* ignore */
            }
          }
          await op('Presence', () => api().setAway(mode), () => (mode === 'afk' ? 'AFK — the Bot has the controls' : mode === 'dnd' ? 'Do not disturb' : 'Online'))
          return
        }
        case '/save':
          await op('Save', () => api().save(), () => 'Genio is curating memory')
          return
        case '/patch':
          requestSystemsSection('patch')
          go('systems')
          return
        case '/help':
          localSystem(['**Commands**', ...SLASH.map((s) => `- \`${s.cmd}\` — ${s.hint}`), '', 'Shortcuts: `Ctrl+K` palette · `Ctrl+1…8` views'].join('\n'))
          return
      }
    }
    playSfx('send', settings)
    att.set([])
    try {
      await api().sendChat(wksp, t, images.length ? toSendable(images) : undefined, inventory.context)
      inventory.sent()
    } catch (e) {
      toast('error', 'Message not sent', errText(e))
      update(t)
      att.set(images)
      inventory.restore(inventory.context)
    }
  }

  return (
    <div className="composer">
      {matches.length > 0 && (
        <div className="slash-menu panel">
          {matches.map((s, i) => (
            <button
              key={s.cmd}
              className={cx('slash-item', i === sel && 'on')}
              onMouseEnter={() => setSel(i)}
              onClick={() => {
                update(s.cmd + ' ')
                ta.current?.focus()
              }}
            >
              <span className="mono neon-text">{s.cmd}</span>
              <span className="mute">{s.hint}</span>
            </button>
          ))}
        </div>
      )}
      {inventory.chips}
      <AttachmentStrip att={att} />
      <div className={cx('composer-box ticks', att.dragging && 'dropping')} {...att.dropProps}>
        <textarea
          ref={ta}
          rows={1}
          value={text}
          onPaste={att.onPaste}
          placeholder={
            busy
              ? `${ASSISTANT_NAME} is working… you can still send; it queues and is read next.`
              : isMain
                ? 'Message Genio  ·  / for commands'
                : `Message ${ASSISTANT_NAME}  ·  it answers you here`
          }
          onChange={(e) => {
            update(e.target.value)
            setSel(0)
          }}
          onKeyDown={(e) => {
            if (matches.length) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSel((s) => (s + 1) % matches.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((s) => (s - 1 + matches.length) % matches.length)
                return
              }
              if (e.key === 'Tab') {
                e.preventDefault()
                update(matches[sel].cmd + ' ')
                return
              }
              if (e.key === 'Enter' && !e.shiftKey && text.trim() !== matches[sel].cmd) {
                e.preventDefault()
                void submit(matches[sel].cmd)
                return
              }
            }
            if (e.key === 'Tab' && e.shiftKey) {
              e.preventDefault()
              cycleShellMode(wksp)
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit(text)
            }
          }}
        />
        <button className="btn solid icon" disabled={!canSend || att.pending > 0} onClick={() => void submit(text)} aria-label="Send">
          <Send size={15} />
        </button>
      </div>
      <div className="composer-hints mute">
        <span>
          <ShellModeButton wksp={wksp} />
          <ChatModelControls wksp={wksp} />
          <span className="composer-keys">
            <kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline · <kbd>/</kbd> commands
          </span>
        </span>
        <span className="quick">
          <button
            className="link-btn"
            disabled={!!recapOff}
            title={recapOff || 'Previously on… then your pending moves'}
            onClick={() => void op('Recap', () => api().recap())}
          >
            Recap
          </button>
          {isMain && <button className="link-btn" onClick={() => openDeploy()}>Deploy</button>}
        </span>
      </div>
    </div>
  )
}

const SHELL_MODES: { id: Settings['chatShellMode']; label: string; hint: string }[] = [
  { id: 'ask', label: 'Ask', hint: 'Read-only commands run; anything else asks you first.' },
  { id: 'auto-shell', label: 'Auto-approve shell', hint: 'Every Bash/PowerShell command in this chat runs without asking. Other tools still ask; the Bot stays read-only.' },
  { id: 'all', label: 'YOLO', hint: 'Nothing will ask for permission: every command and tool this chat can use runs without asking. The Bot stays read-only.' }
]

/** This chat's saved controls: Genio settings for the main chat, the ally's own values (falling back to Genio's) for an ally. */
function useChatControls(wksp: string): ChatControls & { ally?: Ally } {
  const ally = useStore((s) => (wksp === MAIN_PANEL ? undefined : s.snap.allies.find((a) => a.name === wksp && !a.retiredAt)))
  const settings = useStore((s) => s.settings)
  return useMemo(() => ({ ...chatControls(settings, ally), ally }), [settings, ally])
}

function cycleShellMode(wksp: string): void {
  const s = getState()
  const cur = chatControls(s.settings, wksp === MAIN_PANEL ? undefined : s.snap.allies.find((a) => a.name === wksp && !a.retiredAt)).shellMode
  const i = SHELL_MODES.findIndex((m) => m.id === cur)
  void saveChatControls(wksp, { shellMode: SHELL_MODES[(i + 1) % SHELL_MODES.length].id })
}

const inherits = (own: string | undefined): string => (own ? '' : ' (following Genio)')

/** Chat approval-mode switcher (click or Shift+Tab in the input), à la Claude Code. One per chat. */
function ShellModeButton({ wksp }: { wksp: string }) {
  const { shellMode: mode, ally } = useChatControls(wksp)
  const m = SHELL_MODES.find((x) => x.id === mode) ?? SHELL_MODES[0]
  const auto = mode !== 'ask'
  return (
    <button
      className={cx('btn sm', mode === 'all' ? 'alert' : auto ? 'amber' : 'ghost')}
      style={{ marginRight: 12, verticalAlign: 'middle' }}
      title={`${m.hint}${ally ? inherits(ally.shellMode) : ''}\nClick or Shift+Tab to switch.`}
      onClick={() => cycleShellMode(wksp)}
    >
      {auto ? <TriangleAlert size={12} /> : <ShieldCheck size={12} />} {m.label}
    </button>
  )
}

const COMPACT_SELECT: CSSProperties = { width: 'auto', height: 26, padding: '0 6px', fontSize: 10.5, marginRight: 8, verticalAlign: 'middle' }
const APPLY_HINT = 'Applies from the next turn; a turn in progress finishes first.'

/**
 * Model/effort for this chat. Genio: the same wkspModel/wkspEffort settings as Systems › Genio.
 * An ally: its own saved values, following Genio's until changed here.
 */
function ChatModelControls({ wksp }: { wksp: string }) {
  const { model, effort, ally } = useChatControls(wksp)
  const who = ASSISTANT_NAME
  return (
    <>
      <ModelSelect
        value={model}
        title={`${who} model (blank = default)${ally ? inherits(ally.model) : ''}. ${APPLY_HINT}`}
        style={COMPACT_SELECT}
        onChange={(v) => void saveChatControls(wksp, { model: v, effort: '' })}
      />
      <EffortSelect
        model={model}
        value={effort}
        title={`${who} effort${ally ? inherits(ally.effort) : ''}. ${APPLY_HINT}`}
        style={{ ...COMPACT_SELECT, marginRight: 12 }}
        onChange={(v) => void saveChatControls(wksp, { effort: v })}
      />
    </>
  )
}
