import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown, ChevronRight, CircleStop, Radar, RefreshCw, Rocket, Send, ShieldCheck, TriangleAlert, Wrench } from 'lucide-react'
import type { ChatMessage, Settings, Task } from '@shared/types'
import {
  api, errText, focusTask, getState, go, liveTasks, loadChat, op, openDeploy, saveSettings, setState, toast, useStore
} from '../store'
import { Markdown } from '../components/Markdown'
import { GenioCore } from '../components/GenioCore'
import { Chip, Dot, Toggle, useNow } from '../components/ui'
import { KIND_LABEL, STATE_LABEL, isActive, stateTone } from '../lib/vocab'
import { clock, cx, elapsed, trunc } from '../lib/format'
import { playSfx } from '../lib/sfx'
import { getDraft, setDraft } from '../drafts'
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
  const wksp = useStore((s) => s.activeWksp)
  const allies = useStore((s) => s.snap.allies.filter((a) => !a.retiredAt))
  const info = useStore((s) => s.snap.wksps.find((m) => m.name === s.activeWksp))
  const messages = useStore((s) => s.chats[s.activeWksp] ?? [])
  const settings = useStore((s) => s.settings)
  const gamertag = settings?.gamertag || 'Player'
  const calm = !!settings?.calm
  const busy = info?.activity === 'thinking' || info?.activity === 'tool' || info?.activity === 'starting'
  const isAlly = wksp !== 'main'

  useEffect(() => {
    void loadChat(wksp)
  }, [wksp])

  const visible = useMemo(() => (calm ? messages.filter((m) => m.role !== 'wake') : messages), [messages, calm])

  return (
    <div className="comms">
      <section className="comms-main">
        <header className="comms-head">
          <div className="wksp-tabs">
            <button className={cx('wksp-tab', wksp === 'main' && 'on')} onClick={() => setState({ activeWksp: 'main' })}>
              Genio
            </button>
            {allies.map((a) => (
              <button key={a.name} className={cx('wksp-tab', wksp === a.name && 'on')} onClick={() => setState({ activeWksp: a.name })} title={a.scope}>
                Ally · {a.name}
              </button>
            ))}
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

        <ChatLog messages={visible} calm={calm} busy={busy} gamertag={gamertag} activityDetail={info?.activityDetail} lastError={info?.lastError} />

        <Composer wksp={wksp} disabled={isAlly} busy={busy} />
      </section>

      <aside className="comms-side">
        <Roster />
        <Killfeed />
      </aside>
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

function ChatLog({ messages, calm, busy, gamertag, activityDetail, lastError }: { messages: ChatMessage[]; calm: boolean; busy: boolean; gamertag: string; activityDetail?: string; lastError?: string }) {
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
      {messages.length === 0 && (
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
            <span className="working-text">{activityDetail ? trunc(activityDetail, 60) : 'Genio is on it'}</span>
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
        <div className="msg-bubble selectable">{m.text}</div>
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
          Genio · {clock(m.ts)}
          {m.costUsd ? ` · $${m.costUsd.toFixed(3)}` : ''}
        </div>
      </div>
    </div>
  )
}

function Composer({ wksp, disabled, busy }: { wksp: string; disabled: boolean; busy: boolean }) {
  const [text, setText] = useState(() => getDraft(wksp))
  const [sel, setSel] = useState(0)
  const ta = useRef<HTMLTextAreaElement>(null)
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
  const showSlash = text.startsWith('/') && !text.includes(' ') && !text.includes('\n')
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
    if (!t) return
    update('')
    const [cmd, ...rest] = t.split(/\s+/)
    const words = rest.join(' ')
    if (t.startsWith('/')) {
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
    try {
      await api().sendChat(wksp, t)
    } catch (e) {
      toast('error', 'Message not sent', errText(e))
      update(t)
    }
  }

  return (
    <div className={cx('composer', disabled && 'disabled')}>
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
      <div className="composer-box ticks">
        <textarea
          ref={ta}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={disabled ? 'Ally comms are read-only — route work through Genio.' : busy ? 'Genio is working… you can still type; it will read this next.' : 'Message Genio  ·  / for commands'}
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
              cycleShellMode()
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit(text)
            }
          }}
        />
        <button className="btn solid icon" disabled={disabled || !text.trim()} onClick={() => void submit(text)} aria-label="Send">
          <Send size={15} />
        </button>
      </div>
      <div className="composer-hints mute">
        <span>
          <ShellModeButton />
          <ChatModelControls disabled={disabled} />
          <kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline · <kbd>/</kbd> commands
        </span>
        <span className="quick">
          <button className="link-btn" onClick={() => void op('Recap', () => api().recap())}>Recap</button>
          <button className="link-btn" onClick={() => go('status')}>Status</button>
          <button className="link-btn" onClick={() => openDeploy()}>Deploy</button>
        </span>
      </div>
    </div>
  )
}

const SHELL_MODES: { id: Settings['chatShellMode']; label: string; hint: string }[] = [
  { id: 'ask', label: 'Ask', hint: 'Read-only commands run; anything else asks you first.' },
  { id: 'auto-shell', label: 'Auto-approve shell', hint: 'Every Bash/PowerShell command in the Genio chat runs without asking. Other tools still ask; the Bot stays read-only.' }
]

function cycleShellMode(): void {
  const cur = getState().settings?.chatShellMode ?? 'ask'
  const i = SHELL_MODES.findIndex((m) => m.id === cur)
  void saveSettings({ chatShellMode: SHELL_MODES[(i + 1) % SHELL_MODES.length].id })
}

/** Chat approval-mode switcher (click or Shift+Tab in the input), à la Claude Code. */
function ShellModeButton() {
  const mode = useStore((s) => s.settings?.chatShellMode ?? 'ask')
  const m = SHELL_MODES.find((x) => x.id === mode) ?? SHELL_MODES[0]
  const auto = mode === 'auto-shell'
  return (
    <button
      className={cx('btn sm', auto ? 'amber' : 'ghost')}
      style={{ marginRight: 12, verticalAlign: 'middle' }}
      title={`${m.hint}\nClick or Shift+Tab to switch.`}
      onClick={cycleShellMode}
    >
      {auto ? <TriangleAlert size={12} /> : <ShieldCheck size={12} />} {m.label}
    </button>
  )
}

const COMPACT_SELECT: CSSProperties = { width: 'auto', height: 26, padding: '0 6px', fontSize: 10.5, marginRight: 8, verticalAlign: 'middle' }
const APPLY_HINT = 'Applies from the next turn; a turn in progress finishes first.'

/** Genio model/effort for this chat: the same wkspModel/wkspEffort settings as Systems › Genio. */
function ChatModelControls({ disabled }: { disabled: boolean }) {
  const model = useStore((s) => s.settings?.wkspModel ?? '')
  const effort = useStore((s) => s.settings?.wkspEffort ?? '')
  return (
    <>
      <ModelSelect
        value={model}
        disabled={disabled}
        title={`Genio model (blank = default). ${APPLY_HINT}`}
        style={COMPACT_SELECT}
        onChange={(v) => void saveSettings({ wkspModel: v })}
      />
      <EffortSelect
        value={effort}
        disabled={disabled}
        title={`Genio effort. ${APPLY_HINT}`}
        style={{ ...COMPACT_SELECT, marginRight: 12 }}
        onChange={(v) => void saveSettings({ wkspEffort: v })}
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
