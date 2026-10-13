import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown, ChevronRight, CircleStop, Radar, RefreshCw, Rocket, Send, ShieldCheck, TriangleAlert, Wrench } from 'lucide-react'
import type { Ally, ChatMessage, Settings, Task } from '@shared/types'
import { chatControls, routedRequest, type ChatControls } from '@shared/chat'
import {
  api, errText, focusTask, getState, go, liveTasks, loadChat, op, openDeploy, saveChatControls, saveSettings, setDock, setState, toast, useStore
} from '../store'
import { Markdown } from '../components/Markdown'
import { GenioCore } from '../components/GenioCore'
import { ChatDock } from '../components/ChatDock'
import { Chip, Dot, Toggle, useNow } from '../components/ui'
import { KIND_LABEL, STATE_LABEL, isActive, stateTone } from '../lib/vocab'
import { clock, cx, elapsed, trunc } from '../lib/format'
import { playSfx } from '../lib/sfx'
import { getDraft, setDraft } from '../drafts'
import { AttachmentStrip, MessageImages, toSendable, useAttachments } from '../components/ChatImages'
import { MAIN_PANEL, markSeen } from '../lib/dock'
import { EffortSelect, ModelSelect, requestSystemsSection } from './Systems'

const SLASH: { cmd: string; hint: string }[] = [
  { cmd: '/recap', hint: 'Previously on… then your pending moves, one at a time' },
  { cmd: '/status', hint: 'Status Screen: Your Move · Loot · In Progress · Up Next' },
  { cmd: '/deploy', hint: 'Open the Deploy panel' },
  { cmd: '/afk', hint: 'Go AFK — the Bot plays, outcomes replay on return' },
  { cmd: '/dnd', hint: 'Do not disturb — routine events stay off-screen' },
  { cmd: '/online', hint: 'Back online — everything reported here' },
  { cmd: '/save', hint: 'Curate Player Profile & Lore (save game)' },
  { cmd: '/patch', hint: 'Check for a Genio update' },
  { cmd: '/help', hint: 'List commands' }
]

const NOOP_RE = /^\s*(all clear|gg,? all clear)\b/i

export function Comms() {
  const allyNames = useStore((s) => s.snap.allies.filter((a) => !a.retiredAt).map((a) => a.name).join('\n'))

  // Closed allies still get their history, so the dock can flag unread messages.
  useEffect(() => {
    for (const name of allyNames.split('\n')) if (name) void loadChat(name)
  }, [allyNames])

  return (
    <div className="comms">
      <section className="comms-main">
        <ChatDock render={(p) => <ChatPanel key={p} wksp={p} />} />
      </section>

      <aside className="comms-side">
        <Roster />
        <Killfeed />
      </aside>
    </div>
  )
}

/** One chat in the dock: its own status bar, log and composer. */
function ChatPanel({ wksp }: { wksp: string }) {
  const info = useStore((s) => s.snap.wksps.find((m) => m.name === wksp))
  const ally = useStore((s) => s.snap.allies.find((a) => a.name === wksp && !a.retiredAt))
  const messages = useStore((s) => s.chats[wksp] ?? [])
  const settings = useStore((s) => s.settings)
  const gamertag = settings?.gamertag || 'Player'
  const calm = !!settings?.calm
  const busy = info?.activity === 'thinking' || info?.activity === 'tool' || info?.activity === 'starting'
  const isAlly = wksp !== MAIN_PANEL

  useEffect(() => {
    void loadChat(wksp)
  }, [wksp])

  // This panel is on screen: everything in it counts as read.
  const lastTs = messages.length ? messages[messages.length - 1].ts : ''
  useEffect(() => {
    if (lastTs) setDock((d) => markSeen(d, wksp, lastTs))
  }, [wksp, lastTs])

  const visible = useMemo(() => (calm ? messages.filter((m) => m.role !== 'wake') : messages), [messages, calm])

  return (
    <div className="chat-panel">
      <header className="comms-head">
        <div className="chat-title">
          {isAlly ? (
            <>
              <span className="label violet-text">Ally</span>
              <span className="mute chat-scope" title={ally?.scope}>
                {ally?.scope}
              </span>
            </>
          ) : (
            <span className="label neon-text">Genio</span>
          )}
        </div>
        <div className="comms-status">
          <span className={cx('activity', info?.activity)}>
            <Dot tone={info?.activity === 'error' ? 'alert' : busy ? 'neon' : info?.activity === 'offline' ? 'mute' : 'volt'} pulse={busy} />
            {activityText(info?.activity, info?.activityDetail)}
          </span>
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

      <ChatLog wksp={wksp} messages={visible} calm={calm} busy={busy} gamertag={gamertag} activityDetail={info?.activityDetail} lastError={info?.lastError} />

      <Composer wksp={wksp} busy={busy} />
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

function ChatLog({ wksp, messages, calm, busy, gamertag, activityDetail, lastError }: { wksp: string; messages: ChatMessage[]; calm: boolean; busy: boolean; gamertag: string; activityDetail?: string; lastError?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages, busy])
  return (
    <div
      className="chat-log"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }}
    >
      {messages.length === 0 && wksp !== MAIN_PANEL && (
        <div className="chat-empty rise">
          <GenioCore size={80} state={busy ? 'active' : 'idle'} />
          <h2 className="title" style={{ fontSize: 24 }}>
            Ally <span className="violet-text">{wksp}</span>
          </h2>
          <p className="dim">Talk to it directly here, or let Genio route in-scope work to it. Both show up in this timeline; answers to Genio's requests also go back to Genio.</p>
        </div>
      )}
      {messages.length === 0 && wksp === MAIN_PANEL && (
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
              Status
            </button>
            <button className="btn solid" onClick={() => openDeploy()}>
              <Rocket size={14} /> Deploy
            </button>
          </div>
        </div>
      )}
      {messages.map((m) => (
        <Message key={m.id} m={m} calm={calm} gamertag={gamertag} />
      ))}
      {busy && (
        <div className="msg genio working rise">
          <div className="msg-avatar">
            <GenioCore size={34} state="active" />
          </div>
          <div className="working-line">
            <span className="working-text">{activityDetail ? trunc(activityDetail, 60) : `${wksp === MAIN_PANEL ? 'Genio' : wksp} is on it`}</span>
            <span className="working-dots">
              <i />
              <i />
              <i />
            </span>
          </div>
        </div>
      )}
      {lastError && !busy && <div className="msg-error mono">{lastError}</div>}
    </div>
  )
}

function Message({ m, calm, gamertag }: { m: ChatMessage; calm: boolean; gamertag: string }) {
  const [open, setOpen] = useState(false)
  if (m.role === 'player') {
    return (
      <div className="msg player rise">
        {m.images?.length ? <MessageImages wksp={m.wksp} images={m.images} /> : null}
        {m.text && <div className="msg-bubble selectable">{m.text}</div>}
        <div className="msg-meta">
          {gamertag} · {clock(m.ts)}
        </div>
      </div>
    )
  }
  if (m.role === 'wake') {
    return (
      <div className="msg-wake mono" title={m.text}>
        <span className="neon-text">⚡</span> {trunc(m.text.split('\n')[0], 140)}
        <span className="mute"> · {clock(m.ts)}</span>
      </div>
    )
  }
  const routed = m.wksp !== MAIN_PANEL ? routedRequest(m) : null
  if (routed) {
    return (
      <div className="msg player from-genio rise">
        <div className="msg-from label neon-text">From Genio</div>
        <div className="msg-bubble selectable">
          <Markdown text={routed.text} />
        </div>
        <div className="msg-meta">
          Genio → {m.wksp} · {clock(m.ts)}
          {routed.corr ? ` · ${routed.corr}` : ''}
        </div>
      </div>
    )
  }
  if (m.role === 'system') {
    return (
      <div className="msg-system rise">
        <Markdown text={m.text} />
      </div>
    )
  }
  if (m.role === 'error') {
    return <div className="msg-error mono selectable">{m.text}</div>
  }
  const noop = NOOP_RE.test(m.text) && m.text.length < 90
  const tools = m.tools ?? []
  return (
    <div className={cx('msg genio rise', noop && 'noop', calm && noop && 'calm-noop')}>
      <div className="msg-avatar">
        <GenioCore size={34} state={m.partial ? 'active' : 'idle'} />
      </div>
      <div className="msg-content">
        {m.text && <Markdown text={m.text} className={m.partial ? 'streaming' : ''} />}
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
          {m.wksp === MAIN_PANEL ? 'Genio' : m.wksp} · {clock(m.ts)}
          {m.costUsd ? ` · $${m.costUsd.toFixed(3)}` : ''}
        </div>
      </div>
    </div>
  )
}

function Composer({ wksp, busy }: { wksp: string; busy: boolean }) {
  // Client-side commands drive the whole app, so they live in the main chat; an ally gets its text (and its own /help, /status, /save) as typed.
  const isMain = wksp === MAIN_PANEL
  const [text, setText] = useState(() => getDraft(wksp))
  const [sel, setSel] = useState(0)
  const ta = useRef<HTMLTextAreaElement>(null)
  const att = useAttachments(wksp)
  const canSend = !!text.trim() || att.images.length > 0
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
  const settings = useStore((s) => s.settings)
  const showSlash = isMain && text.startsWith('/') && !text.includes(' ') && !text.includes('\n')
  const matches = showSlash ? SLASH.filter((s) => s.cmd.startsWith(text.toLowerCase())) : []

  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(220, el.scrollHeight) + 'px'
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
      await api().sendChat(wksp, t, images.length ? toSendable(images) : undefined)
    } catch (e) {
      toast('error', 'Message not sent', errText(e))
      update(t)
      att.set(images)
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
      <AttachmentStrip att={att} />
      <div className={cx('composer-box ticks', att.dragging && 'dropping')} {...att.dropProps}>
        <textarea
          ref={ta}
          rows={1}
          value={text}
          onPaste={att.onPaste}
          placeholder={
            busy
              ? `${isMain ? 'Genio' : wksp} is working… you can still type; it will read this next.`
              : isMain
                ? 'Message Genio  ·  / for commands'
                : `Message ${wksp}  ·  it answers you here`
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
          <kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline · <kbd>/</kbd> commands · <kbd>Ctrl</kbd>+<kbd>V</kbd> image
        </span>
        {isMain && (
          <span className="quick">
            <button className="link-btn" onClick={() => void op('Recap', () => api().recap())}>Recap</button>
            <button className="link-btn" onClick={() => go('status')}>Status</button>
            <button className="link-btn" onClick={() => openDeploy()}>Deploy</button>
          </span>
        )}
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
  const who = ally ? ally.name : 'Genio'
  return (
    <>
      <ModelSelect
        value={model}
        title={`${who} model (blank = default)${ally ? inherits(ally.model) : ''}. ${APPLY_HINT}`}
        style={COMPACT_SELECT}
        onChange={(v) => void saveChatControls(wksp, { model: v })}
      />
      <EffortSelect
        value={effort}
        title={`${who} effort${ally ? inherits(ally.effort) : ''}. ${APPLY_HINT}`}
        style={{ ...COMPACT_SELECT, marginRight: 12 }}
        onChange={(v) => void saveChatControls(wksp, { effort: v })}
      />
    </>
  )
}
function Roster() {
  const tasks = useStore(liveTasks)
  const now = useNow(1000)
  return (
    <div className="side-block">
      <div className="side-head">
        <span className="label">Squad</span>
        <span className="num dim">{tasks.length}</span>
      </div>
      {tasks.length === 0 ? (
        <div className="side-empty mute">
          No units deployed.{' '}
          <button className="link-btn" onClick={() => openDeploy()}>
            Deploy one
          </button>
        </div>
      ) : (
        <div className="roster">
          {tasks.map((t) => (
            <RosterRow key={t.id} t={t} now={now} />
          ))}
        </div>
      )}
    </div>
  )
}

function RosterRow({ t, now }: { t: Task; now: number }) {
  const tone = t.kind === 'scout' && isActive(t.state) ? 'violet' : stateTone(t.state)
  return (
    <button className="roster-row" onClick={() => focusTask(t.id)}>
      <Dot tone={tone} pulse={isActive(t.state) || t.state === 'needs-decision'} />
      <div className="roster-main">
        <div className="roster-title">{t.title}</div>
        <div className="roster-sub mute">
          {t.kind === 'scout' ? <Radar size={10} /> : <Rocket size={10} />} {KIND_LABEL[t.kind]} · {t.project}
        </div>
      </div>
      <div className="roster-right">
        <span className="roster-state" style={{ color: `var(--${tone === 'mute' ? 'text-mute' : tone})` }}>
          {STATE_LABEL[t.state]}
        </span>
        <span className="mono mute">{elapsed(t.createdAt, now)}</span>
      </div>
    </button>
  )
}

function Killfeed() {
  const feed = useStore((s) => s.feed)
  const tasks = useStore((s) => s.snap.tasks)
  const titleOf = (id?: string): string | undefined => tasks.find((t) => t.id === id)?.title
  return (
    <div className="side-block grow">
      <div className="side-head">
        <span className="label">Killfeed</span>
      </div>
      {feed.length === 0 ? (
        <div className="side-empty mute">Quiet on the map.</div>
      ) : (
        <div className="killfeed">
          {feed.map((f) => (
            <button key={f.id} className={cx('kf-row', `kf-${f.tone}`)} onClick={() => f.taskId && focusTask(f.taskId)} disabled={!f.taskId}>
              <span className="kf-time mono">{clock(f.ts)}</span>
              <span className="kf-tag">{f.kind}</span>
              <span className="kf-text">
                {f.taskId && <b>{trunc(titleOf(f.taskId) ?? f.taskId, 22)} </b>}
                {trunc(f.text, 90)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
