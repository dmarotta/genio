import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Clock, Sparkles, X } from 'lucide-react'
import { pendingDecision } from '@shared/decisions'
import type { Decision } from '@shared/types'
import { api, focusTask, op, openDecisions, setState, useStore } from '../store'
import { Markdown } from './Markdown'
import { Chip, useNow } from './ui'
import { cx, ago, dateShort } from '../lib/format'
import { playSfx } from '../lib/sfx'
import { answerKey, isRecommended, quickRecommendation } from '../lib/choice'

/** Choices stay beside the current screen, without a scrim or a focus trap. */
export function Answers() {
  useNow(30_000)
  const decisions = useStore(s => openDecisions(s))
  const open = useStore(s => s.answersOpen)
  const history = useStore(s => s.answerHistory)
  const target = useStore(s => s.answerTarget)
  const all = useStore(s => s.snap.decisions)
  useEffect(() => {
    if (open && target) document.getElementById(`answer-${target}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [open, target, history, all])
  if (!open || (!decisions.length && !history)) return null
  const visible = history ? all.filter(d => history === 'answered' ? !!d.resolvedAt : !d.resolvedAt && !pendingDecision(d)) : decisions
  const sorted = [...visible].sort((a, b) => history === 'answered' ? (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? '') : a.urgency === b.urgency ? a.createdAt.localeCompare(b.createdAt) : a.urgency === 'urgent' ? -1 : 1)
  return (
    <aside className="answers" id="answers" aria-label="Pending answers">
      <header className="answers-head">
        <span className="label amber-text">{history === 'answered' ? 'Answered' : history === 'deferred' ? 'Deferred' : 'Pending answers'} &middot; {sorted.length}</span>
        <button className="btn sm ghost icon" aria-label="Hide pending answers" onClick={() => setState({ answersOpen: false })}><X size={16} /></button>
      </header>
      <nav className="choice-actions" aria-label="Answer history">
        <button className="btn sm ghost" aria-pressed={!history} onClick={() => setState({ answerHistory: undefined })}>Pending ({decisions.length})</button>
        <button className="btn sm ghost" aria-pressed={history === 'answered'} onClick={() => setState({ answerHistory: 'answered' })}>Answered</button>
        <button className="btn sm ghost" aria-pressed={history === 'deferred'} onClick={() => setState({ answerHistory: 'deferred' })}>Deferred</button>
      </nav>
      <div className="answers-list">{sorted.length ? sorted.map(d => history ?
        <div className="choice panel" id={`answer-${d.id}`} key={d.id}>
          <div className="choice-q">{d.question}</div>
          {d.project && <span className="chip">{d.project}</span>}
          <p>{d.resolvedAt ? `Answered ${dateShort(d.resolvedAt)}: ${d.answer ?? ''}` : `Deferred until ${dateShort(d.until!)}`}</p>
          {!d.resolvedAt && <button className="btn sm" onClick={() => void op('Resume choice', () => api().deferDecision(d.id, '')).then(() => setState({ answerHistory: undefined }))}>Resume</button>}
        </div> : <AnswerCard key={d.id} d={d} />) : <p className="mute">No {history ?? 'pending'} choices.</p>}</div>
    </aside>
  )
}

export function AnswerCard({ d }: { d: Decision }) {
  const task = useStore((s) => (d.taskId ? s.snap.tasks.find((t) => t.id === d.taskId) : undefined))
  const settings = useStore((s) => s.settings)
  const [answer, setAnswer] = useState('')
  const [later, setLater] = useState(false)
  const [until, setUntil] = useState(() => new Date(Date.now() + 86400000).toISOString().slice(0, 10))
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const quickRec = quickRecommendation(d)

  // Auto-grow the answer box from one line up to the CSS max-height.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [answer])

  const submit = async (text: string): Promise<void> => {
    if (!text.trim() || submitting.current) return
    submitting.current = true
    setBusy(true)
    const r = await op('Your move', () => api().answerDecision(d.id, text.trim()))
    if (r?.ok) playSfx('decision', settings)
    submitting.current = false
    setBusy(false)
  }

  const sourceLabel: Record<Decision['source'], string> = { unit: 'From a unit', genio: 'From Genio', validation: 'From the Gauntlet', ally: 'From an ally', system: 'System' }

  return (
    <div id={`answer-${d.id}`} className={cx('choice panel rise', d.urgency === 'urgent' && 'urgent')}>
      <div className="choice-meta">
        <span className="label amber-text">{sourceLabel[d.source]}</span>
        {d.urgency === 'urgent' && <Chip tone="alert">Urgent</Chip>}
        {d.project && <span className="chip">{d.project}</span>}
        <span className="mono mute">{ago(d.createdAt)} ago</span>
        {task && (
          <button className="link-btn choice-task" title={task.title} onClick={() => focusTask(task.id)}>
            {task.title} →
          </button>
        )}
      </div>
      <div className="choice-q">{d.question}</div>
      {quickRec && d.recommendation && (
        <div className="choice-rec">
          <Sparkles size={11} /> Recommended: {d.recommendation}
        </div>
      )}
      {d.context && (
        <div className="choice-context">
          <Markdown text={d.context} className="md-compact" />
        </div>
      )}
      {d.options.length > 0 && (
        <div className="choice-options">
          {d.options.map((o, i) => {
            const rec = isRecommended(o, d.recommendation)
            return (
              <button key={i} className={cx('option', rec && 'rec')} disabled={busy} title={rec ? `Recommended: ${d.recommendation}` : undefined} onClick={() => void submit(o)}>
                <span className="option-key num">{i + 1}</span>
                <span className="option-text">{o}</span>
                {rec && <Sparkles size={11} className="volt-text" />}
              </button>
            )
          })}
        </div>
      )}
      <div className="choice-answer">
        <textarea
          ref={box}
          aria-label="Your answer"
          disabled={busy}
          className="textarea"
          rows={1}
          value={answer}
          placeholder={d.options.length || quickRec ? 'Or answer in your own words…' : 'Your answer…'}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => {
            const act = answerKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })
            if (act === 'submit') {
              e.preventDefault()
              void submit(answer)
            } else if (act === 'blur') {
              e.preventDefault()
              e.currentTarget.blur()
            }
          }}
        />
        <div className="choice-actions">
          <span className="choice-hint mute">
            <kbd>Enter</kbd> lock in · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line
          </span>
          {quickRec && (
            <button className="btn sm volt" disabled={busy} title={quickRec} onClick={() => void submit(quickRec)}>
              <Sparkles size={12} /> Go with recommendation
            </button>
          )}
          {later ? (
            <>
              <input className="input compact" type="date" aria-label="Defer until" disabled={busy} value={until} onChange={(e) => setUntil(e.target.value)} />
              <button
                className="btn sm"
                disabled={busy || !until || !Number.isFinite(Date.parse(until))}
                onClick={() =>
                  void op('Deferred', () => api().deferDecision(d.id, new Date(until).toISOString()), () => `Back on ${dateShort(new Date(until).toISOString())}`).then(() => setLater(false))
                }
              >
                Confirm
              </button>
              <button className="btn sm ghost" onClick={() => setLater(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn sm ghost" disabled={busy} onClick={() => setLater(true)}>
              <Clock size={13} /> Later
            </button>
          )}
          <button className="btn sm solid amber" disabled={busy || !answer.trim()} onClick={() => void submit(answer)}>
            Lock in
          </button>
        </div>
      </div>
    </div>
  )
}
