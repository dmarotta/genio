import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Clock, History, MessageCircleQuestionMark, Sparkles, Undo2, X } from 'lucide-react'
import { pendingDecision } from '@shared/decisions'
import type { Decision } from '@shared/types'
import { choiceGroup, reviewRecommendation, type RecommendationReview, type RecommendationResult } from '@shared/choice'
import { answerNext, api, focusTask, getState, op, openDecisions, setState, useStore } from '../store'
import { Markdown } from './Markdown'
import { Chip, useNow } from './ui'
import { cx, ago, dateShort } from '../lib/format'
import { playSfx } from '../lib/sfx'
import { answerKey, isRecommended, quickRecommendation } from '../lib/choice'
import { CARD_ENTER_MS, CARD_EXIT_MS, CARD_LIMIT, cardCueAllowed, cardCues, cardQueue, reconcileSlots, type CardSlot } from '../lib/answer-queue'

/** Ctrl+J: Answer next. */
export const ANSWER_NEXT_KEY = 'j'

/**
 * Pending choices float over the right edge below the title bar, oldest first (urgent first),
 * at most CARD_LIMIT at a time. They never take room from the screen underneath, never take
 * focus on their own (only Answer next does), and Escape hands focus back.
 */
export function Answers() {
  useNow(30_000)
  const decisions = useStore(s => openDecisions(s))
  const open = useStore(s => s.answersOpen)
  const history = useStore(s => s.answerHistory)
  const target = useStore(s => s.answerTarget)
  const focusRequest = useStore(s => s.answerFocus)
  const [reviewing, setReviewing] = useState(false)
  const [active, setActive] = useState<string>()
  const lane = useRef<HTMLDivElement>(null)
  const back = useRef<HTMLElement | null>(null)
  const cues = useRef<{ queue: string[]; shown: string[] }>(undefined)
  const { queue, shown, waiting } = cardQueue(decisions, target)
  const stacking = open && !history && !reviewing
  const current = shown.find(d => d.id === active)?.id ?? shown[0]?.id

  useEffect(() => { if (!open) setReviewing(false) }, [open])
  useEffect(() => { if (target) setActive(target) }, [target])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.defaultPrevented || e.key.toLowerCase() !== ANSWER_NEXT_KEY) return
      e.preventDefault()
      answerNext()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Answer next: one attempt right after the request renders; with nothing pending, nothing is taken later.
  useEffect(() => {
    if (!focusRequest || !lane.current) return
    setActive(undefined)
    // A compact first card expands when its question takes focus and passes focus into itself.
    const first = lane.current.querySelector<HTMLElement>('.answer-card:not(.out) :is(.option, textarea, .choice-expand):not(:disabled)')
    if (!first) return
    const was = document.activeElement
    if (was instanceof HTMLElement && was !== document.body && !lane.current.contains(was)) back.current = was
    first.focus()
  }, [focusRequest])

  const queueKey = queue.map(d => d.id).join('\n')
  const shownKey = shown.map(d => d.id).join('\n')
  useEffect(() => {
    if (!stacking) { cues.current = undefined; return }
    const c = cardCues(cues.current, { queue, shown })
    cues.current = { queue: queue.map(d => d.id), shown: shown.map(d => d.id) }
    if (!c.in && !c.out) return
    const s = getState()
    const ctx = { settings: s.settings, away: s.snap.away.mode, focused: document.visibilityState !== 'hidden' && document.hasFocus() }
    if (c.out && cardCueAllowed('card-out', ctx)) playSfx('card-out', s.settings)
    if (c.in && cardCueAllowed('card-in', { ...ctx, urgent: c.urgent })) playSfx('card-in', s.settings)
  }, [stacking, queueKey, shownKey])

  const returnFocus = (): void => {
    const el = back.current
    back.current = null
    if (el?.isConnected) el.focus()
    else if (document.activeElement instanceof HTMLElement && lane.current?.contains(document.activeElement)) document.activeElement.blur()
  }
  // A card that dequeues while it holds focus hands focus back instead of dropping it.
  useLayoutEffect(() => {
    const focused = document.activeElement
    if (focused && lane.current?.querySelector('.answer-card.out')?.contains(focused)) returnFocus()
  })

  if (!open) return null
  return (
    <div
      className="answers-float"
      id="answers"
      role="region"
      aria-label="Pending answers"
      ref={lane}
      onFocus={e => { if (e.relatedTarget instanceof HTMLElement && !lane.current?.contains(e.relatedTarget)) back.current = e.relatedTarget }}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); returnFocus() } }}
    >
      {history ? <HistoryPanel key={history} history={history} pending={decisions.length} target={target} /> : <>
        {!reviewing && <CardStack shown={shown} current={current} onActivate={setActive} />}
        {(decisions.length > 0 || reviewing) && (
          <div className="answers-foot">
            {waiting > 0 && !reviewing && (
              <span className="answers-pill" role="status" aria-label={`${waiting} more waiting. Answer next: Ctrl+J`} title="Answer next: Ctrl+J">
                +{waiting} waiting <kbd>Ctrl J</kbd>
              </span>
            )}
            <RecommendationBatches decisions={decisions} onReview={setReviewing} />
            {!reviewing && <>
              <button className="btn sm ghost icon" aria-label="Answer history" title="Answered and deferred" onClick={() => setState({ answerHistory: 'answered' })}><History size={14} /></button>
              <button className="btn sm ghost icon" aria-label="Hide pending answers" title="Hide (the title bar badge brings them back)" onClick={() => setState({ answersOpen: false })}><X size={14} /></button>
            </>}
          </div>
        )}
      </>}
    </div>
  )
}

function useReducedMotion(): boolean {
  const query = (): MediaQueryList | undefined => (typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : undefined)
  const [reduced, setReduced] = useState(() => !!query()?.matches)
  useEffect(() => {
    const q = query()
    if (!q) return
    const on = (): void => setReduced(q.matches)
    q.addEventListener?.('change', on)
    return () => q.removeEventListener?.('change', on)
  }, [])
  return reduced
}

/**
 * The visible cards. A card that leaves slides and fades out of the flow while the rest slide
 * up into place (FLIP) and newcomers slide in from the right; with reduced motion they only fade.
 */
function CardStack({ shown, current, onActivate }: { shown: Decision[]; current?: string; onActivate: (id: string) => void }) {
  const reduced = useReducedMotion()
  const box = useRef<HTMLDivElement>(null)
  const tops = useRef(new Map<string, number>())
  const opened = useRef(current)
  const ids = shown.map(d => d.id).join('\n')
  const [stack, setStack] = useState(() => ({ ids, slots: shown.map((d): CardSlot => ({ id: d.id, d, phase: 'idle' })) }))
  let slots = stack.slots
  if (stack.ids !== ids) {
    slots = reconcileSlots(stack.slots, shown, tops.current).map(s => (s.phase === 'out' && s.open === undefined ? { ...s, open: s.id === opened.current } : s))
    setStack({ ids, slots })
  }
  const latest = new Map(shown.map(d => [d.id, d]))

  useEffect(() => {
    const timers = stack.slots.filter(s => s.phase !== 'idle').map(s => window.setTimeout(() => setStack(st => ({
      ...st,
      slots: s.phase === 'out' ? st.slots.filter(x => !(x.id === s.id && x.phase === 'out')) : st.slots.map(x => (x.id === s.id && x.phase === 'in' ? { ...x, phase: 'idle' } : x))
    })), s.phase === 'out' ? CARD_EXIT_MS : CARD_ENTER_MS))
    return () => timers.forEach(t => window.clearTimeout(t))
  }, [stack.slots])

  useLayoutEffect(() => {
    opened.current = current
    const next = new Map<string, number>()
    for (const el of box.current?.querySelectorAll<HTMLElement>('[data-card]:not(.out)') ?? []) {
      const id = el.dataset.card!
      const top = el.offsetTop
      const was = tops.current.get(id)
      next.set(id, top)
      if (!reduced && was !== undefined && was !== top && typeof el.animate === 'function') {
        el.animate([{ transform: `translateY(${was - top}px)` }, { transform: 'none' }], { duration: CARD_EXIT_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' })
      }
    }
    tops.current = next
  })

  return (
    <div className={cx('answer-stack', reduced && 'reduced')} ref={box}>
      {slots.map(s => (
        <AnswerCard
          key={s.id}
          d={latest.get(s.id) ?? s.d}
          phase={s.phase}
          top={s.phase === 'out' ? s.top : undefined}
          compact={s.phase === 'out' ? !s.open : s.id !== current}
          onActivate={() => onActivate(s.id)}
        />
      ))}
    </div>
  )
}

function HistoryPanel({ history, pending, target }: { history: 'answered' | 'deferred'; pending: number; target?: string }) {
  const all = useStore(s => s.snap.decisions)
  const rows = all
    .filter(d => (history === 'answered' ? !!d.resolvedAt : !d.resolvedAt && !pendingDecision(d)))
    .sort((a, b) => (history === 'answered' ? (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? '') : a.createdAt.localeCompare(b.createdAt)))
  const [page, setPage] = useState(() => Math.max(0, Math.floor(rows.findIndex(d => d.id === target) / CARD_LIMIT)))
  const pages = Math.max(1, Math.ceil(rows.length / CARD_LIMIT))
  const p = Math.min(page, pages - 1)
  return (
    <section className="panel answers-history" aria-label="Answer history">
      <header className="answers-head">
        <span className="label amber-text">{history === 'answered' ? 'Answered' : 'Deferred'} &middot; {rows.length}</span>
        <button className="btn sm ghost icon" aria-label="Hide pending answers" onClick={() => setState({ answersOpen: false })}><X size={14} /></button>
      </header>
      <nav className="choice-actions answers-tabs" aria-label="Answer history">
        <button className="btn sm ghost" onClick={() => setState({ answerHistory: undefined })}>Pending ({pending})</button>
        <button className="btn sm ghost" aria-pressed={history === 'answered'} onClick={() => setState({ answerHistory: 'answered' })}>Answered</button>
        <button className="btn sm ghost" aria-pressed={history === 'deferred'} onClick={() => setState({ answerHistory: 'deferred' })}>Deferred</button>
      </nav>
      {rows.length ? rows.slice(p * CARD_LIMIT, (p + 1) * CARD_LIMIT).map(d => (
        <div className="choice answers-row" id={`answer-${d.id}`} key={d.id}>
          <div className="choice-q">{d.question}</div>
          {d.project && <span className="chip">{d.project}</span>}
          <p>{d.resolvedAt ? `Answered ${dateShort(d.resolvedAt)}: ${d.answer ?? ''}` : `Deferred until ${dateShort(d.until!)}`}</p>
          {!d.resolvedAt && <button className="btn sm" onClick={() => void op('Resume choice', () => api().deferDecision(d.id, '')).then(() => setState({ answerHistory: undefined }))}>Resume</button>}
        </div>
      )) : <p className="mute">No {history} choices.</p>}
      {pages > 1 && (
        <div className="choice-actions">
          <button className="btn sm ghost" disabled={p === 0} onClick={() => setPage(p - 1)}><ChevronLeft size={13} /> Newer</button>
          <span className="mono mute">{p + 1}/{pages}</span>
          <button className="btn sm ghost" disabled={p >= pages - 1} onClick={() => setPage(p + 1)}>Older <ChevronRight size={13} /></button>
        </div>
      )}
    </section>
  )
}

function RecommendationBatches({ decisions, onReview }: { decisions: Decision[]; onReview: (reviewing: boolean) => void }) {
  const [review, setReview] = useState<{ question: string; context?: string; scope: string; row: RecommendationReview }[]>([])
  const [results, setResults] = useState<RecommendationResult[] | null>(null)
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)
  const groups = new Map<string, Decision[]>()
  for (const d of decisions) {
    if (!reviewRecommendation(d)) continue
    const group = choiceGroup(d)
    groups.set(group, [...(groups.get(group) ?? []), d])
  }
  const apply = async () => {
    if (sending.current) return
    sending.current = true
    setBusy(true)
    try {
      const r = await api().applyRecommendations(review.map(r => r.row))
      setResults(r)
    } catch (error) {
      setResults(review.map(r => ({ id: r.row.id, ok: false, message: (error as Error).message })))
    } finally { sending.current = false; setBusy(false) }
  }
  if (review.length) return (
    <section className="panel choice answers-review" aria-label="Review recommendations">
      <div className="label">Review recommendations · {review.length} · {review[0].scope}</div>
      <p>Only these choices will be applied. Changed choices stay pending.</p>
      {review.map(({ question, context, row }) => <div key={row.id} className="choice-context">
        <div>{question}</div><strong>Answer: {row.answer}</strong>
        {context && <details><summary>Details</summary><Markdown text={context} className="md-compact" /></details>}
        {results?.find(r => r.id === row.id) && <p role="status">{results.find(r => r.id === row.id)!.ok ? 'Applied' : 'Not applied'}: {results.find(r => r.id === row.id)!.message}</p>}
      </div>)}
      {!results && <button className="btn sm volt" disabled={busy} onClick={() => void apply()}>Apply recommendations ({review.length})</button>}
      <button className="btn sm ghost" disabled={busy} onClick={() => { setReview([]); setResults(null); onReview(false) }}>{results ? 'Close results' : 'Cancel review'}</button>
    </section>
  )
  return <>{[...groups].filter(([, rows]) => rows.length > 1).map(([key, rows]) => <button key={key} className="btn sm" title={`${rows[0].project ?? rows[0].wksp} · ${rows[0].batch ?? rows[0].taskId ?? rows[0].backlogId}`} onClick={() => {
    setResults(null)
    onReview(true)
    setReview(rows.map(d => ({ question: d.question, context: d.context, scope: `${d.project ?? d.wksp} · ${d.batch ?? d.taskId ?? d.backlogId ?? d.id}`, row: reviewRecommendation(d)! })))
  }}>Review recommendations ({rows.length})</button>)}</>
}

const SOURCE_LABEL: Record<Decision['source'], string> = { unit: 'From a unit', genio: 'From Genio', validation: 'From the Gauntlet', ally: 'From an ally', system: 'System' }

/** One floating card. Compact cards show only the question; activating one expands it. */
export function AnswerCard({ d, phase = 'idle', top, compact = false, onActivate }: { d: Decision; phase?: CardSlot['phase']; top?: number; compact?: boolean; onActivate?: () => void }) {
  const task = useStore((s) => (d.taskId ? s.snap.tasks.find((t) => t.id === d.taskId) : undefined))
  const [answer, setAnswer] = useState('')
  const [clarifying, setClarifying] = useState(false)
  const [question, setQuestion] = useState('')
  const [receipt, setReceipt] = useState('')
  const draft = clarifying ? question : answer
  const [later, setLater] = useState(false)
  const [until, setUntil] = useState(() => new Date(Date.now() + 86400000).toISOString().slice(0, 10))
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const expanding = useRef(false)
  const quickRec = quickRecommendation(d)

  // Expanding from the keyboard keeps focus inside the card.
  useLayoutEffect(() => {
    if (compact || !expanding.current) return
    expanding.current = false
    card.current?.querySelector<HTMLElement>('.option:not(:disabled), textarea')?.focus()
  }, [compact])

  // Auto-grow the answer box from one line up to the CSS max-height.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [draft, compact])

  // The dequeue cue plays when the card leaves the queue (see Answers), not here.
  const submit = async (text: string, clarification = false): Promise<void> => {
    if (!text.trim() || submitting.current) return
    submitting.current = true
    setBusy(true)
    try {
      const r = await op(clarification ? 'Ask for clarification' : 'Your move', () => clarification ? api().clarifyDecision(d.id, text.trim()) : api().answerDecision(d.id, text.trim()))
      if (r?.ok && clarification) { setReceipt(r.message); setQuestion(''); setClarifying(false) }
    } finally { submitting.current = false; setBusy(false) }
  }

  const urgent = d.urgency === 'urgent'
  return (
    <div
      id={`answer-${d.id}`}
      ref={card}
      data-card={d.id}
      className={cx('answer-card choice panel', urgent && 'urgent', compact && 'compact', phase !== 'idle' && phase)}
      style={top !== undefined ? { top } : undefined}
      aria-hidden={phase === 'out' || undefined}
      onFocus={onActivate}
      onClick={compact ? onActivate : undefined}
    >
      <div className="choice-meta">
        <span className={cx('label', urgent ? 'alert-text' : 'amber-text')}>{SOURCE_LABEL[d.source]}</span>
        {urgent && <Chip tone="alert">Urgent</Chip>}
        {d.project && <span className="chip">{d.project}</span>}
        <span className="mono mute">{ago(d.createdAt)} ago</span>
        {task && !compact && (
          <button className="link-btn choice-task" title={task.title} onClick={() => focusTask(task.id)}>
            {task.title} →
          </button>
        )}
      </div>
      {compact ? (
        <button className="choice-q choice-expand" aria-expanded={false} title={d.question} onFocus={() => { expanding.current = true }}>{d.question}</button>
      ) : <>
        <div className="choice-q" title={d.question}>{d.question}</div>
        {quickRec && d.recommendation && (
          <div className="choice-rec">
            <Sparkles size={11} /> Recommended: {d.recommendation}
          </div>
        )}
        {d.context && (
          <details className="choice-context">
            <summary>Details</summary>
            <Markdown text={d.context} className="md-compact" />
          </details>
        )}
        {receipt && <p role="status">{receipt}</p>}
        {d.clarifications?.map((c, i) => <details key={i} className="choice-context"><summary>Clarification requested</summary>{c.question}</details>)}
        {!clarifying && d.options.length > 0 && (
          <div className="choice-options">
            {d.options.map((o, i) => {
              const rec = isRecommended(o, d.recommendation) && d.options.filter(option => isRecommended(option, d.recommendation)).length === 1
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
            aria-label={clarifying ? 'Your clarification question' : 'Your answer'}
            disabled={busy}
            className="textarea"
            rows={1}
            value={draft}
            placeholder={clarifying ? 'What would you like explained?' : d.options.length || quickRec ? 'Or answer in your own words…' : 'Your answer…'}
            onChange={(e) => clarifying ? setQuestion(e.target.value) : setAnswer(e.target.value)}
            onKeyDown={(e) => {
              const act = answerKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })
              if (act === 'submit') {
                e.preventDefault()
                void submit(draft, clarifying)
              }
              // Escape bubbles to the lane, which hands focus back to where it came from.
            }}
          />
          <div className="choice-actions">
            <span className="choice-hint mute">
              <kbd>Enter</kbd> {clarifying ? 'send question' : 'lock in'} · <kbd>Esc</kbd> back
            </span>
            {!clarifying && quickRec && (
              <button className="btn sm volt" disabled={busy} title={quickRec} aria-label="Go with recommendation" onClick={() => void submit(quickRec)}>
                <Sparkles size={12} /> <span className="btn-label">Go with recommendation</span>
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
              <button className="btn sm ghost" disabled={busy} title="Later" aria-label="Later" onClick={() => setLater(true)}>
                <Clock size={13} /> <span className="btn-label">Later</span>
              </button>
            )}
            <button className="btn sm ghost" disabled={busy} title={clarifying ? 'Back to answer' : 'Ask for clarification'} aria-label={clarifying ? 'Back to answer' : 'Ask for clarification'} onClick={() => { setClarifying(!clarifying); box.current?.focus() }}>
              {clarifying ? <Undo2 size={13} /> : <MessageCircleQuestionMark size={13} />} <span className="btn-label">{clarifying ? 'Back to answer' : 'Ask for clarification'}</span>
            </button>
            <button className="btn sm solid amber" disabled={busy || !draft.trim()} onClick={() => void submit(draft, clarifying)}>
              {clarifying ? 'Send question' : 'Lock in'}
            </button>
          </div>
        </div>
      </>}
    </div>
  )
}
