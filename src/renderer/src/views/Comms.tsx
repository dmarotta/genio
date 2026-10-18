import { ASSISTANT_NAME } from '@shared/assistant'
import { GenerationCard } from '../components/GenerationCard'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { ArrowDown, ChevronDown, ChevronRight, ChevronsUp, CircleStop, CornerUpRight, Pencil, Play, Send, ShieldCheck, TriangleAlert, X } from 'lucide-react'
import type { Ally, ChatMessage, WkspInfo, Settings, ShellRun } from '@shared/types'
import { isShellCommandMessage, isShellText } from '@shared/terminal-pane'
import { chatControls, chatKey, routedRequest, splitQueued, type ChatControls, type UnqueuedChat } from '@shared/chat'
import { MAX_IMAGES_PER_MESSAGE } from '@shared/chat-images'
import {
  PROJECT_WKSP, PROJECT_WINDOW, api, errText, getState, loadChat, op, saveChatControls, setState, toast, useStore
} from '../store'
import { readShellHistory, rememberShellCommand, shellUnavailable, showPane } from '../lib/terminal-pane'
import { Markdown } from '../components/Markdown'
import { CopyMessageButton } from '../components/CopyMessageButton'
import { GenioCore } from '../components/GenioCore'
import { Roster } from '../components/SquadPanel'
import { clock, cx, trunc } from '../lib/format'
import { playSfx } from '../lib/sfx'
import { getDraft, setDraft } from '../drafts'
import { AttachmentStrip, GeneratingImages, MessageImages, fromSendable, toSendable, useAttachments } from '../components/ChatImages'
import type { InventoryContext } from '@shared/inventory-context'
import { InventoryContextChips, useInventoryContext } from '../components/InventoryContextChips'
const MAIN_PANEL = 'main'
import { EffortSelect, ModelSelect } from '../components/ModelSelect'
import { openSettings } from '../lib/settings-nav'
import { settingsPath } from '@shared/settings-pages'
import { useVoiceInput } from '../components/MicButton'
import { stopSpeaking } from '../lib/voice'
import { QuotaProtectionNotice } from '../components/QuotaProtectionNotice'


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

/** One empty list until the chat loads: a new [] per store change would re-render the whole chat each time. */
const NO_MESSAGES: ChatMessage[] = []

/** What a chat pane reads of its session: the project chat's WkspInfo, or a design chat's own state. */
type ChatSessionInfo = Pick<WkspInfo, 'activity' | 'activityDetail' | 'steerable' | 'limit' | 'botLimit' | 'lastError'>

/** Who answers in this chat, in the copy: Genio, or a design chat (which never speaks as Genio). */
const speaker = (conversation?: string): string => (conversation ? 'The Lore chat' : ASSISTANT_NAME)
/** A design chat's id as a call's last argument; the project chat's calls keep their shape. */
const onDesign = (conversation?: string): [] | [string] => (conversation ? [conversation] : [])

/**
 * The project chat: its log and composer. With `conversation`, one of the project's design chats
 * (the Design screen): the same log and composer with only its model and effort.
 */
export function ChatPanel({ wksp, conversation, context, surface = 'screen', active: _active = true }: { wksp: string; conversation?: string; context?: InventoryContext; surface?: 'screen' | 'panel'; active?: boolean }) {
  const key = chatKey(wksp, conversation)
  const wkspInfo = useStore((s) => s.snap.wksps.find((m) => m.name === wksp))
  const designInfo = useStore((s) => (conversation ? s.designChats?.find((c) => c.id === conversation) : undefined))
  const info: ChatSessionInfo | undefined = conversation ? designInfo : wkspInfo
  const messages = useStore((s) => s.chats[key] ?? NO_MESSAGES)
  const calm = useStore((s) => !!s.settings?.calm)
  const busy = info?.activity === 'thinking' || info?.activity === 'tool' || info?.activity === 'starting'
  // the session's own turn state: a visible Genio turn runs that a message can steer (never the Bot's)
  const steerable = !!info?.steerable

  useEffect(() => {
    void loadChat(wksp, false, conversation)
  }, [wksp, conversation])

  const visible = useMemo(() => messages.filter((m) => !hidden(m, calm)), [messages, calm])

  // Edit / cancel a message the session has not picked up yet; edit puts it back in this chat's composer.
  // Stable across renders so memoised messages are not re-rendered by every streamed token.
  const fill = useRef<((c: UnqueuedChat) => void) | undefined>(undefined)
  const takeBack = useCallback(async (m: ChatMessage, edit: boolean): Promise<void> => {
    try {
      const got = await api().unqueueChat(wksp, m.id, ...onDesign(conversation))
      if (!got) toast('info', 'Already sent', `${speaker(conversation)} picked that message up before it could be changed.`)
      else if (edit) fill.current?.(got)
    } catch (e) {
      toast('error', edit ? 'Message not editable' : 'Message not cancelled', errText(e))
    }
  }, [wksp, conversation])
  // A queued message jumps the queue and steers: the turn in progress stops at a safe point and reads it first.
  // The message turns to "Steering" at once; a toast says only why it cannot be sent now.
  const sendNow = useCallback(async (m: ChatMessage): Promise<void> => {
    try {
      const r = await api().sendQueuedNow(wksp, m.id, ...onDesign(conversation))
      if (!r.ok) toast('info', 'Not sent now', r.reason)
    } catch (e) {
      toast('error', 'Message not sent now', errText(e))
    }
  }, [wksp, conversation])

  return (
    <div className="chat-panel">
      {!conversation && <QuotaProtectionNotice project={PROJECT_WINDOW ?? wksp} />}
      {(['genio', 'bot'] as const).map(role => {
        const limit = role === 'bot' ? info?.botLimit : info?.limit
        if (!limit) return null
        return <div className="chat-limit" role="status" key={role}>
          <span>{role === 'bot' ? 'Bot: ' : ''}{limit.provider === 'codex' ? `${limit.reason || 'Codex unavailable'} Open ${settingsPath('accounts')}, then resume the session.` : limit.reason || (limit.restartRequired
            ? 'Claude still reports an expired limit. Restart the session to try again.'
            : `Claude limit reached${limit.resetsAt ? `, back at ${new Date(limit.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ', waiting for reset'}`)}</span>
          {limit.provider === 'codex' && <button className="btn sm" onClick={() => openSettings('accounts')}>Accounts &amp; keys</button>}
          <button className="btn sm" onClick={() => void op('Restart', () => api().restartWksp(wksp, false, role, ...onDesign(conversation)))}>{limit.restartRequired ? 'Restart session' : 'Retry now'}</button>
        </div>
      })}

      <ChatLog key={key} wksp={wksp} conversation={conversation} surface={surface} messages={visible} busy={busy} activityDetail={info?.activityDetail} lastError={info?.lastError} onTakeBack={takeBack} onSendNow={sendNow} />

      <Composer wksp={wksp} conversation={conversation} steerable={steerable} fill={fill} context={context} />
    </div>
  )
}

/**
 * A Genio turn with nothing to show (tool-only turns, empty partials) never gets a bare header and timestamp.
 * Clean chat also drops wakes.
 */
function hidden(m: ChatMessage, calm: boolean): boolean {
  if (m.role === 'wake') return calm
  return m.role === 'genio' && !m.text.trim() && !m.generation && !m.generating && !m.images?.length
}

type TakeBack = (m: ChatMessage, edit: boolean) => Promise<void>
type SendNow = (m: ChatMessage) => Promise<void>

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

function ChatLog({ wksp, conversation, surface, messages: all, busy, activityDetail, lastError, onTakeBack, onSendNow }: { wksp: string; conversation?: string; surface: string; messages: ChatMessage[]; busy: boolean; activityDetail?: string; lastError?: string; onTakeBack: TakeBack; onSendNow?: SendNow }) {
  const ref = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const memoryKey = `${chatKey(wksp, conversation)}:${surface}`
  const design = !!conversation
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
    // Re-pin while new messages, streamed deltas, late layout, late history or a resize move the bottom, as long as
    // the player follows it. The observer reports after layout, before paint: reading the bottom there forces no
    // layout of its own, where a layout effect per delta did (once per streamed delta).
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

  const markIntent = (): void => { intent.current.at = performance.now(); jumping.current = false }
  // The jump control overlays the viewport as the scroller's sibling, so it never takes part in
  // (or scrolls with) the log's flow, whatever late layout or streaming does to the content.
  return (
    <div className="chat-viewport">
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
          {all.length === 0 && !design && <p className="chat-empty dim rise">Tell {ASSISTANT_NAME} what to build in this project.</p>}
          {messages.map((m) => (
            <Message key={m.id} m={m} design={design} onTakeBack={onTakeBack} />
          ))}
          {busy && (
            <div className="msg genio working rise">
              {!design && <div className="msg-avatar">
                <GenioCore size={34} state="active" />
              </div>}
              <div className="working-line">
                <span className="working-text">{activityDetail ? trunc(activityDetail, 60) : design ? 'Thinking' : `${ASSISTANT_NAME} is on it`}</span>
                <span className="working-dots">
                  <i />
                  <i />
                  <i />
                </span>
                {!design && (
                  <button className="btn sm alert" onClick={() => void op('Interrupt', () => api().interruptWksp(wksp))}>
                    <CircleStop size={13} /> Interrupt
                  </button>
                )}
              </div>
            </div>
          )}
          {lastError && !busy && <div className="msg-error mono">{lastError} <button className="btn sm" onClick={() => void op('Restart', () => (conversation ? api().restartWksp(wksp, false, undefined, conversation) : api().restartWksp(wksp, false)))}>Restart session</button></div>}
          {queued.map((m) => (
            <Message key={m.id} m={m} design={design} onTakeBack={onTakeBack} onSendNow={onSendNow} />
          ))}
        </div>
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
const Message = memo(function Message({ m, design = false, onTakeBack, onSendNow }: { m: ChatMessage; design?: boolean; onTakeBack: TakeBack; onSendNow?: SendNow }) {
  if (m.role === 'player') {
    const waiting = m.queue === 'queued' || m.queue === 'unsent'
    return (
      <div data-msg={m.id} className={cx('msg player rise', waiting && m.queue)}>
        {m.images?.length ? <MessageImages wksp={m.wksp} images={m.images.filter(i => i.file !== m.context?.thumbnail?.image?.file)} /> : null}
        {m.text && <div className="msg-bubble selectable">{m.text}</div>}
        <InventoryContextChips context={m.context} wksp={m.wksp} />
        <div className="msg-meta">
          {m.queue === 'queued' && (m.steering ? <span className="msg-queue steering">Steering ·{' '}</span> : <span className="msg-queue">Queued ·{' '}</span>)}
          {m.queue === 'unsent' && <span className="msg-queue">Not sent ·{' '}</span>}
          {clock(m.ts)}
          <CopyMessageButton text={m.text} />
          {waiting && (
            <span className="msg-acts">
              {m.queue === 'queued' && !m.steering && onSendNow && (
                <button className="msg-act msg-send-now" aria-label="Send queued message now" onClick={() => void onSendNow(m)}>
                  <ChevronsUp size={12} /> Send now
                </button>
              )}
              <button className="msg-act" title="Edit" aria-label="Edit queued message" onClick={() => void onTakeBack(m, true)}>
                <Pencil size={11} />
              </button>
              <button className="msg-act" title="Cancel" aria-label="Cancel queued message" onClick={() => void onTakeBack(m, false)}>
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
  const routed = m.wksp !== MAIN_PANEL && !design ? routedRequest(m) : null
  if (routed) {
    return (
      <div data-msg={m.id} className="msg player from-genio rise">
        <div className="msg-from label neon-text">From Genio</div>
        <div className="msg-bubble selectable">
          <Markdown text={routed.text} />
        </div>
        <div className="msg-meta">{clock(m.ts)}<CopyMessageButton text={routed.text} /></div>
      </div>
    )
  }
  if (m.role === 'system' && m.shell) return <ShellResult id={m.id} run={m.shell} ts={m.ts} />
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
  return (
    <div data-msg={m.id} className="msg genio rise">
      {!design && <div className="msg-avatar">
        <GenioCore size={34} state={m.partial ? 'active' : 'idle'} />
      </div>}
      <div className="msg-content">
        {m.text && !m.generation && <Markdown text={m.text} className={m.partial ? 'streaming' : ''} />}
        {m.generation && <GenerationCard card={m.generation} wksp={m.wksp} />}
        {m.generating ? <GeneratingImages count={m.generating} /> : null}
        {m.images?.length ? <MessageImages wksp={m.wksp} images={m.images} /> : null}
        <div className="msg-meta">{clock(m.ts)}<CopyMessageButton text={m.text} /></div>
      </div>
    </div>
  )
})

/** A shell-mode draft is stored with its leading '!'; the composer shows the command after the glyph. */
const withoutBang = (d: string): string => (isShellText(d) ? d.slice(1) : d)

const SHELL_PREVIEW_LINES = 12

/**
 * A '!' command the player ran: command, exit code and output (first lines, then Show more).
 * Marked "run by you" so it never reads as something Genio or a unit did.
 */
function ShellResult({ id, run, ts }: { id: string; run: ShellRun; ts: string }) {
  const [open, setOpen] = useState(true)
  const [all, setAll] = useState(false)
  const lines = run.output ? run.output.split('\n') : []
  const long = lines.length > SHELL_PREVIEW_LINES
  const shown = all || !long ? run.output : lines.slice(0, SHELL_PREVIEW_LINES).join('\n')
  const ok = !run.error && run.exitCode === 0
  return (
    <div data-msg={id} className={cx('msg-shell rise', ok ? 'ok' : 'bad')}>
      <div className="msg-shell-head">
        <button className="msg-shell-toggle" aria-expanded={open} aria-label={open ? 'Collapse output' : 'Expand output'} onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <span className="chip amber msg-shell-who">run by you</span>
        <code className="msg-shell-cmd selectable">$ {run.command}</code>
        <span className={cx('msg-shell-exit mono', ok ? 'volt-text' : 'alert-text')}>{run.error ? 'did not run' : `exit ${run.exitCode ?? '?'}`}</span>
        <span className="mute mono msg-shell-time">{clock(ts)}</span>
        <CopyMessageButton text={`$ ${run.command}\n${run.output}`} />
      </div>
      {open && (
        <div className="msg-shell-body">
          {run.error && <div className="alert-text">{run.error}</div>}
          {run.output ? <pre className="msg-shell-out selectable">{shown}</pre> : !run.error && <div className="mute">(no output)</div>}
          {(long || run.truncated) && (
            <div className="msg-shell-foot mute">
              {long && <button className="link-btn" onClick={() => setAll((a) => !a)}>{all ? 'Show less' : `Show more (${lines.length - SHELL_PREVIEW_LINES} more lines)`}</button>}
              {run.truncated && <span>Long output: its start and end are kept.</span>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Composer({ wksp, conversation, steerable = false, fill, context }: { wksp: string; conversation?: string; steerable?: boolean; context?: InventoryContext; fill: RefObject<((c: UnqueuedChat) => void) | undefined> }) {
  // A design chat's composer: text and images, its model and effort; no shell.
  const design = !!conversation
  const key = chatKey(wksp, conversation)
  // '!' as the first character: shell mode. The '!' becomes the prompt glyph; the draft keeps it.
  const [shell, setShell] = useState(() => !design && isShellText(getDraft(key)))
  const [text, setText] = useState(() => withoutBang(getDraft(key)))
  const unavailable = useStore(shellUnavailable)
  const history = useRef<{ list: string[]; at: number; draft: string }>({ list: [], at: -1, draft: '' })
  const ta = useRef<HTMLTextAreaElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const att = useAttachments(key)
  const inventory = useInventoryContext(key, context)
  const canSend = !!text.trim() || att.images.length > 0
  const update = (v: string, inShell = shell): void => {
    setText(v)
    setDraft(key, (inShell ? '!' : '') + v)
  }
  /** Spoken words land at the caret like typed text (a space keeps them apart from what is there). */
  const voice = useVoiceInput({ box, insert: (said) => {
    const el = ta.current
    const at = el ? el.selectionStart : text.length, to = el ? el.selectionEnd : text.length
    const before = text.slice(0, at), after = text.slice(to)
    const piece = (before && !/\s$/.test(before) ? ' ' : '') + said + (after && !/^\s/.test(after) ? ' ' : '')
    update(before + piece + after)
    if (el) {
      el.focus()
      requestAnimationFrame(() => el.setSelectionRange(at + piece.length, at + piece.length))
    }
  } })
  const shellMode = (on: boolean, v = ''): void => {
    setShell(on)
    history.current = { list: [], at: -1, draft: '' }
    update(v, on)
  }

  // Restore this chat's draft (on mount or chat switch) with the caret at the end.
  useLayoutEffect(() => {
    const raw = getDraft(key)
    const d = withoutBang(raw)
    setShell(!design && isShellText(raw))
    setText(d)
    const el = ta.current
    if (el && d) {
      el.value = d
      el.setSelectionRange(d.length, d.length)
    }
  }, [key, design])
  // A queued message taken back for editing: its text goes first (ahead of any draft), its images join the strip.
  useEffect(() => {
    fill.current = (c) => {
      inventory.restore(c.context)
      const draft = withoutBang(getDraft(key))
      const next = [c.text, draft].filter((s) => s.trim()).join('\n\n')
      setShell(false)
      update(next, false)
      if (c.images?.length) att.set([...fromSendable(c.images), ...att.images].slice(0, MAX_IMAGES_PER_MESSAGE))
      const el = ta.current
      if (el) {
        el.focus()
        requestAnimationFrame(() => el.setSelectionRange(next.length, next.length))
      }
    }
  })
  const settings = useStore((s) => s.settings)

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
  }, [text, key])

  // One submit per draft: a double click or Enter repeated before the cleared composer renders sends nothing more.
  const submitted = useRef(false)
  useEffect(() => { submitted.current = false })

  /**
   * Shell mode: the command runs in the project's shell (a tab in the terminal pane, opened if hidden), and its
   * result block joins this chat as run by the player. It never goes to Genio as chat text.
   */
  const runCommand = async (): Promise<void> => {
    const command = text.trim()
    if (!command || !PROJECT_WINDOW) return
    if (unavailable) {
      toast('error', 'Shell unavailable', unavailable)
      return
    }
    if (submitted.current) return
    submitted.current = true
    rememberShellCommand(PROJECT_WINDOW, command)
    shellMode(false)
    try {
      const t = await api().paneRun(PROJECT_WINDOW, wksp, command, getState().paneCwd)
      setState((s) => ({ terminals: { ...s.terminals, [t.id]: t } }))
      showPane(t.id)
    } catch (e) {
      toast('error', 'Command not run', errText(e))
      shellMode(true, command)
    }
  }

  /** `steer`: the turn in progress stops at a safe point and reads this first; otherwise it queues while busy. */
  const submit = async (raw: string, steer = false): Promise<void> => {
    if (shell) return runCommand()
    const t = raw.trim()
    const images = att.images
    if (!t && !images.length) return
    // A leading '!' is a shell command, never chat text for Genio; here shell mode could not start.
    if (isShellCommandMessage(t)) {
      toast('error', 'Shell unavailable', unavailable ?? 'Type ! first to run a shell command.')
      return
    }
    if (att.pending) {
      toast('info', 'Attaching images', 'Wait a moment for the images to finish attaching.')
      return
    }
    if (submitted.current) return
    submitted.current = true
    update('')
    playSfx('send', settings)
    att.set([])
    try {
      const sendable = images.length ? toSendable(images) : undefined
      if (steer) await api().steerChat(wksp, t, sendable, inventory.context, ...onDesign(conversation))
      else await api().sendChat(wksp, t, sendable, inventory.context, ...onDesign(conversation))
      inventory.sent()
    } catch (e) {
      toast('error', 'Message not sent', errText(e))
      update(t)
      att.set(images)
      inventory.restore(inventory.context)
    }
  }

  /** Shell mode's keys: Enter runs, Esc and Backspace on the empty prompt leave it, the arrows walk the history. True when handled. */
  const shellKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    const el = e.currentTarget
    if (e.key === 'Escape' || (e.key === 'Backspace' && !text && el.selectionStart === 0 && el.selectionEnd === 0)) {
      e.preventDefault()
      if (e.key === 'Escape' && text) update('')
      else shellMode(false)
      return true
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void runCommand()
      return true
    }
    if (e.key === 'ArrowUp' && !text.slice(0, el.selectionStart).includes('\n')) {
      // Read fresh each time a walk starts: the other composer (floating or main) may have run commands.
      if (history.current.at < 0) history.current = { list: PROJECT_WINDOW ? readShellHistory(PROJECT_WINDOW) : [], at: -1, draft: text }
      const h = history.current
      if (h.at >= h.list.length - 1) return false
      e.preventDefault()
      h.at++
      update(h.list[h.list.length - 1 - h.at])
      return true
    }
    const h = history.current
    if (e.key === 'ArrowDown' && h.at >= 0 && !text.slice(el.selectionEnd).includes('\n')) {
      e.preventDefault()
      h.at--
      update(h.at < 0 ? h.draft : h.list[h.list.length - 1 - h.at])
      return true
    }
    return false
  }

  return (
    <div className="composer">
      {inventory.chips}
      <AttachmentStrip att={att} />
      <div ref={box} className={cx('composer-box ticks', att.dragging && 'dropping', shell && 'shell')} {...att.dropProps}>
        {shell && <span className="composer-shell-glyph mono" aria-hidden>!</span>}
        <textarea
          ref={ta}
          rows={1}
          value={text}
          onPaste={att.onPaste}
          aria-label={shell ? 'Shell command' : 'Message'}
          placeholder={shell ? 'Shell command' : design ? 'Message the Lore chat' : `Message ${ASSISTANT_NAME}`}
          onChange={(e) => {
            const v = e.target.value
            voice.clearError()
            if (!shell && !design && isShellText(v) && !unavailable) shellMode(true, v.slice(1))
            else update(v)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') stopSpeaking()
            // Enter while listening ends the recording; the words then wait in the box for the next Enter.
            if (voice.listening && e.key === 'Enter') {
              e.preventDefault()
              voice.stop()
              return
            }
            if (shell && shellKey(e)) return
            if (e.key === 'Tab' && e.shiftKey && !design) {
              e.preventDefault()
              cycleShellMode(wksp)
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              // Ctrl+Enter steers a running turn; with nothing to steer it is a plain send
              void submit(text, (e.ctrlKey || e.metaKey) && steerable)
            }
          }}
        />
        {voice.button}
        {steerable && !shell && (
          <button className="btn amber composer-steer" disabled={!canSend || att.pending > 0} onClick={() => void submit(text, true)} title="Ctrl+Enter">
            <CornerUpRight size={14} /> Steer
          </button>
        )}
        {shell ? (
          <button className="btn amber icon" disabled={!text.trim() || !!unavailable} onClick={() => void runCommand()} aria-label="Run command"
            title={unavailable ?? 'Run'}>
            <Play size={15} />
          </button>
        ) : (
          <button className="btn solid icon" disabled={!canSend || att.pending > 0} onClick={() => void submit(text)} aria-label="Send" title="Send">
            <Send size={15} />
          </button>
        )}
      </div>
      {!shell && !design && unavailable && isShellText(text) && <div className="composer-shell-off alert-text" role="status">Shell mode is unavailable: {unavailable}</div>}
      {voice.error && <div className="composer-shell-off alert-text" role="status">{voice.error}</div>}
      {design ? (
        <div className="composer-hints mute">
          <span><DesignModelControls wksp={wksp} conversation={conversation} /></span>
        </div>
      ) : <div className="composer-hints mute">
        <span>
          <ShellModeButton wksp={wksp} />
          <ChatModelControls wksp={wksp} />
          {shell && (
            <span className="composer-keys composer-shell-keys">
              Shell mode · <kbd>Enter</kbd> run · <kbd>↑</kbd> history · <kbd>Esc</kbd> chat
            </span>
          )}
        </span>
      </div>}
    </div>
  )
}

const SHELL_MODES: { id: Settings['chatShellMode']; label: string; hint: string }[] = [
  { id: 'ask', label: 'Ask', hint: 'Read-only commands run; anything else asks you first.' },
  { id: 'auto-shell', label: 'Auto-approve shell', hint: 'Every Bash/PowerShell command in this chat runs without asking. Other tools still ask; the Bot stays read-only.' },
  { id: 'all', label: 'YOLO', hint: 'Nothing asks but spending and Fable or Astra launches: every command, edit, merge and discard this chat can do runs without asking. The Bot stays read-only.' }
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

/** Chat approval-mode switcher (click or Shift+Tab in the input), à la Claude Code. One per chat. */
function ShellModeButton({ wksp }: { wksp: string }) {
  const { shellMode: mode } = useChatControls(wksp)
  const m = SHELL_MODES.find((x) => x.id === mode) ?? SHELL_MODES[0]
  const auto = mode !== 'ask'
  return (
    <button
      className={cx('btn sm', mode === 'all' ? 'alert' : auto ? 'amber' : 'ghost')}
      style={{ marginRight: 12, verticalAlign: 'middle' }}
      title={m.hint}
      onClick={() => cycleShellMode(wksp)}
    >
      {auto ? <TriangleAlert size={12} /> : <ShieldCheck size={12} />} {m.label}
    </button>
  )
}

const COMPACT_SELECT: CSSProperties = { width: 'auto', height: 26, padding: '0 6px', fontSize: 10.5, marginRight: 8, verticalAlign: 'middle' }

/**
 * Model/effort for this chat. Genio: the same wkspModel/wkspEffort settings as Settings › Usage & limits › Pin models and effort.
 * An ally: its own saved values, following Genio's until changed here.
 */
function ChatModelControls({ wksp }: { wksp: string }) {
  const { model, effort } = useChatControls(wksp)
  return (
    <>
      <ModelSelect
        value={model}
        title="Model"
        style={COMPACT_SELECT}
        onChange={(v) => void saveChatControls(wksp, { model: v, effort: '' })}
      />
      <EffortSelect
        model={model}
        value={effort}
        title="Effort"
        style={{ ...COMPACT_SELECT, marginRight: 12 }}
        onChange={(v) => void saveChatControls(wksp, { effort: v })}
      />
    </>
  )
}

/** A design chat's own model and effort, following the project chat's until changed here. */
function DesignModelControls({ wksp, conversation }: { wksp: string; conversation: string }) {
  const chat = useStore((s) => s.designChats?.find((c) => c.id === conversation))
  const project = useChatControls(wksp)
  const model = chat?.model || project.model
  const save = async (patch: { model?: string; effort?: string }): Promise<void> => {
    const swap = (next: (c: NonNullable<typeof chat>) => NonNullable<typeof chat>): void =>
      setState((s) => ({ designChats: s.designChats?.map((c) => (c.id === conversation ? next(c) : c)) }))
    const before = chat
    swap((c) => ({ ...c, ...patch }))
    try {
      const saved = await api().designChatConfigure(wksp, conversation, patch)
      swap(() => saved)
    } catch (e) {
      if (before) swap(() => before)
      toast('error', 'Lore chat settings not saved', errText(e))
    }
  }
  return (
    <>
      <ModelSelect
        value={model}
        title="Model"
        style={COMPACT_SELECT}
        onChange={(v) => void save({ model: v, effort: '' })}
      />
      <EffortSelect
        model={model}
        value={chat?.effort || project.effort}
        title="Effort"
        style={COMPACT_SELECT}
        onChange={(v) => void save({ effort: v })}
      />
    </>
  )
}
