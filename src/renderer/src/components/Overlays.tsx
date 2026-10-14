import { ASSISTANT_NAME } from '@shared/assistant'
import { useEffect, useState } from 'react'
import { ShieldCheck, Trophy, X } from 'lucide-react'
import { api, dismissToast, getState, op, setState, useStore } from '../store'
import { GenioCore } from './GenioCore'
import { cx, clock } from '../lib/format'

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast rise', `t-${t.level}`)} onClick={() => dismissToast(t.id)}>
          <div className="toast-title">{t.title}</div>
          {t.body && <div className="toast-body selectable">{t.body}</div>}
        </div>
      ))}
    </div>
  )
}

export function AchievementOverlay() {
  const queue = useStore((s) => s.achievements)
  const current = queue[0]
  useEffect(() => {
    if (!current) return
    const t = window.setTimeout(() => setState((s) => ({ achievements: s.achievements.slice(1) })), 4200)
    return () => window.clearTimeout(t)
  }, [current])
  if (!current) return null
  return (
    <div className="achv" key={current.id} onClick={() => setState((s) => ({ achievements: s.achievements.slice(1) }))}>
      <div className="achv-card">
        <div className="achv-icon">
          <Trophy size={30} />
        </div>
        <div>
          <div className="achv-kicker">Achievement unlocked</div>
          <div className="achv-name">{current.name}</div>
          <div className="achv-desc">{current.description}</div>
        </div>
        <div className="achv-shine" />
      </div>
    </div>
  )
}

export function PermissionPrompt() {
  const req = useStore((s) => s.permissions[0])
  const more = useStore((s) => s.permissions.length - 1)
  if (!req) return null
  const resolve = (allow: boolean): void => {
    setState((s) => ({ permissions: s.permissions.filter((p) => p.id !== req.id) }))
    void op('Permission', () => api().resolvePermission(req.id, allow))
  }
  return (
    <div className="modal-scrim strong">
      <div className="modal panel glow ticks rise perm" style={{ width: 600, ['--tone' as string]: 'var(--amber)' }}>
        <header className="modal-head">
          <div>
            <div className="label" style={{ color: 'var(--amber)' }}>
              Access request · {ASSISTANT_NAME}
            </div>
            <h2 className="modal-title">
              <ShieldCheck size={20} style={{ verticalAlign: -3, marginRight: 8, color: 'var(--amber)' }} />
              Genio wants to run <span className="mono amber-text">{req.tool}</span>
            </h2>
          </div>
        </header>
        <div className="modal-body">
          {req.reason && <p className="dim">{req.reason}</p>}
          <pre className="perm-input selectable">{req.input}</pre>
          <p className="mute" style={{ fontSize: 12 }}>
            Genio only reads your projects on its own. Anything that could change them needs your word. {more > 0 && `${more} more waiting.`}
          </p>
        </div>
        <footer className="modal-foot">
          <button className="btn alert" onClick={() => resolve(false)}>
            Deny
          </button>
          <button className="btn solid amber" onClick={() => resolve(true)}>
            Allow once
          </button>
        </footer>
      </div>
    </div>
  )
}

export function BootSplash({ ready }: { ready: boolean }) {
  const [minDone, setMinDone] = useState(false)
  const [skipped, setSkipped] = useState(false)
  const [gone, setGone] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(() => setMinDone(true), 1200)
    return () => window.clearTimeout(t)
  }, [])
  const leaving = (ready && minDone) || skipped
  useEffect(() => {
    if (!leaving) return
    const t = window.setTimeout(() => setGone(true), 450)
    return () => window.clearTimeout(t)
  }, [leaving])
  if (gone) return null
  const lines = ['LINKING CORE', 'SCANNING SQUAD', 'LOADING QUEST LOG', 'SYSTEMS ONLINE']
  return (
    <div className={cx('splash', leaving && 'out')} onClick={() => setSkipped(true)}>
      <div className="splash-inner">
        <GenioCore size={120} state="active" />
        <div className="splash-word" data-text="GENIO">
          GENIO
        </div>
        <div className="splash-sub label">AI squad orchestrator · game dev edition</div>
        <div className="bar splash-bar">
          <i style={{ width: ready ? '100%' : '70%' }} />
        </div>
        <div className="splash-lines mono">
          {lines.map((l, i) => (
            <div key={l} style={{ animationDelay: `${i * 0.22}s` }}>
              <span className="volt-text">▸</span> {l}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Welcome back: escalations captured while AFK/DND, shown once on return. */
export function WelcomeBack() {
  const away = useStore((s) => s.snap.away)
  const dismissedAt = useStore((s) => s.welcomeDismissedAt)
  const gamertag = useStore((s) => s.settings?.gamertag || 'Player')
  const fresh = away.held.filter((e) => !dismissedAt || e.ts > dismissedAt)
  if (away.mode !== 'online' || (!fresh.length && !away.returnSummaryPending)) return null
  if (!fresh.length) return null
  const sevTone: Record<string, string> = { info: 'neon', decision: 'amber', failure: 'alert', ready: 'volt' }
  const close = (): void => setState({ welcomeDismissedAt: fresh.reduce((m, e) => (e.ts > m ? e.ts : m), getState().welcomeDismissedAt ?? '') })
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal panel glow ticks rise" style={{ width: 620 }}>
        <header className="modal-head">
          <div>
            <div className="label" style={{ color: 'var(--volt)' }}>
              Respawned
            </div>
            <h2 className="modal-title">Welcome back, {gamertag}</h2>
          </div>
          <button className="btn ghost icon sm" onClick={close} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="modal-body">
          <p className="dim" style={{ marginTop: 0 }}>
            While you were away the Bot kept the squad moving. Here is what needs your eyes:
          </p>
          <ul className="wb-list">
            {fresh.map((e, i) => (
              <li key={i}>
                <span className={cx('chip', sevTone[e.severity])}>{e.severity}</span>
                <span className="selectable">{e.text}</span>
                <span className="mute mono">{clock(e.ts)}</span>
              </li>
            ))}
          </ul>
        </div>
        <footer className="modal-foot">
          <button
            className="btn"
            onClick={() => {
              close()
              setState({ answersOpen: true })
            }}
          >
            Show pending answers
          </button>
          <button className="btn solid volt" onClick={close}>
            GG, got it
          </button>
        </footer>
      </div>
    </div>
  )
}
