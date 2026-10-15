import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Hand, ThumbsDown, X } from 'lucide-react'
import { cx } from '../lib/format'
import { toneVar, type Tone } from '../lib/vocab'

export function Chip({ tone, children, title, pulse }: { tone?: Tone; children: ReactNode; title?: string; pulse?: boolean }) {
  return (
    <span className={cx('chip', tone && tone !== 'mute' && tone)} title={title}>
      {pulse && <i className="dot pulse" style={{ ['--c' as string]: toneVar(tone ?? 'neon'), width: 6, height: 6 }} />}
      {children}
    </span>
  )
}

export function Dot({ tone, pulse, size = 8 }: { tone: Tone; pulse?: boolean; size?: number }) {
  return <i className={cx('dot', pulse && 'pulse')} style={{ ['--c' as string]: toneVar(tone), width: size, height: size }} />
}

/** Yellow indicator beside a unit's own color: it waits on the player (see squadAttention). */
export function NeedsYou({ compact, className }: { compact?: boolean; className?: string }) {
  return (
    <span className={cx('chip amber needs-you', compact && 'compact', className)} title="Waiting for your answer">
      <Hand size={10} />{!compact && ' needs you'}
    </span>
  )
}

/** A unit or quest your dislike on a Genio message paused; undo the dislike (or answer its choice) to resume. */
export function DislikeMarker() {
  return (
    <span className="chip alert dislike-marker" title="Paused by your dislike on a Genio message. Undo the dislike, or answer its choice, to resume.">
      <ThumbsDown size={10} /> paused by your dislike
    </span>
  )
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className="toggle" style={disabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      {label && <span className="toggle-label">{label}</span>}
    </label>
  )
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 560,
  tone = 'neon',
  kicker
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
  tone?: Tone
  kicker?: string
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal panel glow ticks rise" style={{ width, ['--tone' as string]: toneVar(tone) }}>
        <header className="modal-head">
          <div>
            {kicker && <div className="label" style={{ color: toneVar(tone) }}>{kicker}</div>}
            <h2 className="modal-title">{title}</h2>
          </div>
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}

/** A labelled control; with an id it is also a target that Settings search and deep links can reveal. */
export function Field({ label, hint, children, wide, id }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean; id?: string }) {
  return (
    <label className={cx('field', wide && 'wide')} id={id} tabIndex={id ? -1 : undefined}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; badge?: number }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" className={cx('tab', value === t.id && 'on')} onClick={() => onChange(t.id)}>
          {t.label}
          {!!t.badge && <span className="tab-badge">{t.badge}</span>}
        </button>
      ))}
    </div>
  )
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty rise">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  )
}

export function ViewHeader({ kicker, title, children }: { kicker: string; title: ReactNode; children?: ReactNode }) {
  return (
    <header className="view-head">
      <div>
        <div className="label">{kicker}</div>
        <h1 className="title">{title}</h1>
      </div>
      <div className="view-actions">{children}</div>
    </header>
  )
}

/** Confirm dialog; with `typed`, the player must type the word to arm the button. */
export function Confirm({
  title,
  body,
  confirmLabel,
  tone = 'amber',
  typed,
  onConfirm,
  onClose
}: {
  title: string
  body: ReactNode
  confirmLabel: string
  tone?: Tone
  typed?: string
  onConfirm: () => void | Promise<void>
  onClose: () => void
}) {
  const [txt, setTxt] = useState('')
  const [busy, setBusy] = useState(false)
  const armed = !typed || txt.trim().toUpperCase() === typed.toUpperCase()
  return (
    <Modal
      title={title}
      kicker="Confirm"
      tone={tone}
      onClose={onClose}
      width={480}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className={cx('btn solid', tone !== 'neon' && tone !== 'mute' && tone)}
            disabled={!armed || busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm()
              } finally {
                setBusy(false)
              }
              onClose()
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-body">{body}</div>
      {typed && (
        <Field label={`Type ${typed} to confirm`}>
          <input className="input mono" autoFocus value={txt} onChange={(e) => setTxt(e.target.value)} />
        </Field>
      )}
    </Modal>
  )
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(t)
  }, [intervalMs])
  return now
}

/** Text input that commits on blur / Enter (for settings). */
export function CommitInput({
  value,
  onCommit,
  type = 'text',
  className,
  placeholder,
  mono
}: {
  value: string | number
  onCommit: (v: string) => void
  type?: string
  className?: string
  placeholder?: string
  mono?: boolean
}) {
  const [v, setV] = useState(String(value ?? ''))
  const last = useRef(String(value ?? ''))
  useEffect(() => {
    setV(String(value ?? ''))
    last.current = String(value ?? '')
  }, [value])
  const commit = (): void => {
    if (v !== last.current) {
      last.current = v
      onCommit(v)
    }
  }
  return (
    <input
      className={cx('input', mono && 'mono', className)}
      type={type}
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}
