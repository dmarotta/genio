import { useMemo, useRef, useState, type DragEvent } from 'react'
import { Box, Clock, Copy, ExternalLink, Hand, Link2, Pause, Play, Radar, Rocket, Sparkles, X } from 'lucide-react'
import type { BacklogItem, PlanStep, Priority, StatusEvent, Task, WorkPlan } from '@shared/types'
import { planColumn, planStepOf, type PlanView } from '@shared/work-plan'
import { PRIORITY_LABEL, PlanCard, PlanDetails, usePlanViews } from '../components/PlanCard'
import { PRIORITIES } from '@shared/api'
import {
  buildBoard, queueChips, reorderQueue, visibleBands, type DoneEntry, type FlightCard, type QueueChip
} from '@shared/quest-board'
import type { SquadTone } from '@shared/squad-display'
import { playerStatusText, statusWorthShowing } from '@shared/unit-page'
import { api, focusTask, op, useStore } from '../store'
import { DislikeMarker, Empty, Field, Modal, NeedsYou, ViewHeader, useNow } from '../components/ui'
import { clock, cx, dateShort, trunc } from '../lib/format'
import { useUsagePolicy } from '../components/PlanMeter'
import { useScreenContext } from '../lib/screen-context'

const DONE_PAGE = 12
const DONE_MORE = 25

const KIND_NAME: Record<string, string> = { ship: 'Build', scout: 'Recon', choice: 'Choice' }

/** Squad tones as colors; blue is the Squad's working-Build color. */
export const toneColor = (t: SquadTone | 'mute' | 'neon'): string =>
  t === 'mute' ? 'var(--text-mute)' : `var(--${t})`

export function Quests() {
  const items = useStore((s) => s.snap.backlog)
  const tasks = useStore((s) => s.snap.tasks)
  const plans = useStore((s) => s.snap.plans)
  const decisions = useStore((s) => s.snap.decisions)
  const projects = useStore((s) => s.snap.projects)
  const terminals = useStore((s) => s.terminals)
  const statusByTask = useStore((s) => s.statusByTask)
  const policy = useUsagePolicy()
  const now = useNow(30_000)
  const [openId, setOpenId] = useState<string | null>(null)
  const [openPlanId, setOpenPlanId] = useState<string | null>(null)
  const [doneShown, setDoneShown] = useState(DONE_PAGE)

  const planViews = usePlanViews()
  const built = useMemo(() => buildBoard({ backlog: items, tasks, terminals, decisions, now }), [items, tasks, terminals, decisions, now])
  // a plan is one card: its step quests (and their finished entries) are not cards of their own
  const board = useMemo(() => ({
    queued: built.queued.filter((q) => !questPlan(plans, q)),
    inFlight: built.inFlight.filter((c) => !(c.quest && questPlan(plans, c.quest))),
    done: built.done.filter((d) => !(d.quest && questPlan(plans, d.quest)))
  }), [built, plans])
  const queuedPlans = planViews.filter((v) => planColumn(v) === 'queued')
  const flightPlans = planViews.filter((v) => planColumn(v) === 'in-flight')
  const doneList = useMemo(() => [
    ...board.done.map((d) => ({ key: d.key, at: d.at, d })),
    ...planViews.filter((v) => planColumn(v) === 'done').map((v) => ({ key: `plan-${v.id}`, at: v.endedAt, v }))
  ].sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key)), [board.done, planViews])
  const waits = useMemo(() => new Map((policy?.waiting ?? []).map((w) => [w.id, w.wait])), [policy])
  const worldCaps = useMemo(() => {
    const caps: Record<string, number | undefined> = {}
    for (const p of projects) caps[p.name] = p.capacity && p.capacity > 0 ? p.capacity : undefined
    for (const w of policy?.worlds ?? []) if (w.cap !== undefined) caps[w.name] = Math.min(w.cap, caps[w.name] ?? w.cap)
    return caps
  }, [projects, policy])
  const reasons = (q: BacklogItem): QueueChip[] => {
    const wait = waits.get(q.id)
    return queueChips(q, {
      backlog: items, tasks, terminals, worldCaps, now, plans,
      global: policy ? { cap: policy.unitCap, used: policy.liveUnits } : undefined,
      quota: wait ? { reason: wait.reason, until: wait.until } : undefined
    })
  }
  // only what keeps a quest from starting: a ready quest needs no chip
  const chipsFor = (q: BacklogItem): QueueChip[] => reasons(q).filter((c) => c.kind !== 'ready')

  const open = (q?: BacklogItem, t?: Task): void => {
    if (q) setOpenId(q.id)
    else if (t) focusTask(t.id)
  }
  const openQuest = openId ? items.find((b) => b.id === openId) : undefined
  const openPlan = openPlanId ? planViews.find((v) => v.id === openPlanId) : undefined
  const total = board.queued.length + board.inFlight.length + queuedPlans.length + flightPlans.length
  const columnOf = (q: BacklogItem): string =>
    board.queued.includes(q) ? 'Queued' : board.inFlight.some((c) => c.quest === q) ? 'In flight' : 'Done'
  useScreenContext('quests', { facts: [
    { label: 'Board', value: `${board.queued.length + queuedPlans.length} queued · ${board.inFlight.length + flightPlans.length} in flight · ${doneList.length} done` },
    openPlan && { label: 'Plan', value: `${openPlan.title} [${openPlan.id}] · ${planColumn(openPlan)} · ${openPlan.priority} · ${openPlan.merged}/${openPlan.total} merged` },
    openQuest && { label: 'Quest', value: `${openQuest.title} [${openQuest.id}] · ${columnOf(openQuest)} · ${openQuest.priority} · ${openQuest.kind}` }
  ] })

  return (
    <div className="view quests-view">
      <ViewHeader
        title={
          <>
            Quest <span className="accent">Log</span>
          </>
        }
      />

      {total === 0 && doneList.length === 0 ? (
        <Empty title="No quests yet. Ask Genio to add one." />
      ) : (
        <div className="kanban qk">
          <QueuedColumn queue={board.queued} plans={plans} planCards={queuedPlans} chipsFor={chipsFor} onOpen={(q) => open(q)} onOpenPlan={setOpenPlanId} />
          <section className="kan-col col-in-flight">
            <header className="kan-head">
              <span className="label">In flight</span>
            </header>
            <div className="kan-list">
              {board.inFlight.length + flightPlans.length === 0 && <div className="qk-empty mute">No units on the field.</div>}
              {board.inFlight.map((c) => (
                <FlightTicket key={c.key} c={c} events={c.task ? statusByTask[c.task.id] : undefined} onOpen={() => open(c.quest, c.task)} />
              ))}
              {flightPlans.map((v) => <PlanCard key={`plan-${v.id}`} v={v} onOpen={() => setOpenPlanId(v.id)} />)}
            </div>
          </section>
          <section className="kan-col col-done">
            <header className="kan-head">
              <span className="label">Done</span>
            </header>
            <div className="kan-list">
              {doneList.length === 0 && <div className="qk-empty mute">Nothing finished yet.</div>}
              {doneList.slice(0, doneShown).map((e) => 'd' in e ? (
                <DoneTicket key={e.key} d={e.d} onOpen={() => open(e.d.quest, e.d.task)} />
              ) : (
                <PlanCard key={e.key} v={e.v} onOpen={() => setOpenPlanId(e.v.id)} />
              ))}
              {doneList.length > doneShown && (
                <button className="btn ghost sm qk-more" onClick={() => setDoneShown((n) => n + DONE_MORE)}>
                  Show more
                </button>
              )}
            </div>
          </section>
        </div>
      )}
      {openQuest && <QuestDetails item={openQuest} chips={chipsFor(openQuest)} onClose={() => setOpenId(null)} />}
      {openPlan && <PlanDetails planId={openPlan.id} onClose={() => setOpenPlanId(null)} />}
    </div>
  )
}

// ------------------------------------------------------------------ queued

export function QueuedColumn({ queue: all, plans, planCards = [], chipsFor, onOpen, onOpenPlan }: {
  queue: BacklogItem[]; plans?: WorkPlan[]; planCards?: PlanView[]; chipsFor: (q: BacklogItem) => QueueChip[]
  onOpen: (q: BacklogItem) => void; onOpenPlan?: (id: string) => void
}) {
  // a plan is one card in its priority band; its steps are not cards
  const queue = all.filter((q) => !questPlan(plans, q))
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<Priority | null>(null)
  // the ticket in hand; drag state is set a tick after dragstart because Chromium
  // cancels a drag whose dragstart reflows the page (the empty bands appearing)
  const held = useRef<string | null>(null)

  const start = (id: string): void => {
    held.current = id
    window.setTimeout(() => { if (held.current === id) setDrag(id) })
  }
  const end = (): void => {
    held.current = null
    setDrag(null)
    setOver(null)
  }
  // dragging a standalone quest to another band changes its priority; it joins the end of that band
  const drop = (band: Priority): void => {
    const plan = planCards.find((v) => `plan:${v.id}` === drag)
    const q = queue.find((x) => x.id === drag)
    end()
    if (plan) {
      if (plan.priority !== band) void op('Priority', () => api().planPriority(plan.id, band))
      return
    }
    if (!q || q.priority === band) return
    const patches = reorderQueue(queue, q.id, band)
    if (patches.length) void op('Priority', () => api().backlogReorder(patches))
  }
  const allow = (band: Priority) => (e: DragEvent): void => {
    if (!drag) return
    e.preventDefault()
    if (over !== band) setOver(band)
  }

  return (
    <section className="kan-col col-queued">
      <header className="kan-head">
        <span className="label">Queued</span>
      </header>
      <div className="kan-list">
        {queue.length + planCards.length === 0 && <div className="qk-empty mute">Nothing queued</div>}
        {visibleBands([...queue, ...planCards], !!drag).map((band) => {
          const list = queue.filter((q) => q.priority === band)
          const planList = planCards.filter((v) => v.priority === band)
          return (
            <div
              key={band}
              className={cx('qk-band', `p-${band}`, !list.length && !planList.length && 'vacant', over === band && 'drop-end')}
              onDragOver={allow(band)}
              onDrop={(e) => { e.preventDefault(); drop(band) }}
            >
              <div className="qk-band-head">
                <span className={cx('prio-label', `p-${band}`)}>{PRIORITY_LABEL[band]}</span>
                {!list.length && !planList.length && <span className="qk-drop mute">Drop here</span>}
              </div>
              {planList.map((v) => (
                <div
                  key={v.id}
                  draggable
                  className={cx('qk-drag', drag === `plan:${v.id}` && 'dragging')}
                  onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', `plan:${v.id}`); start(`plan:${v.id}`) }}
                  onDragEnd={end}
                >
                  <PlanCard v={v} onOpen={() => onOpenPlan?.(v.id)} />
                </div>
              ))}
              {list.map((q) => (
                <div
                  key={q.id}
                  draggable
                  className={cx('qk-drag', drag === q.id && 'dragging')}
                  onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', q.id); start(q.id) }}
                  onDragEnd={end}
                >
                  <QueueTicket q={q} chips={chipsFor(q)} onOpen={() => onOpen(q)} />
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** Why a queued quest cannot start now: its hold, or the unlanded quest it waits on. */
function dispatchBlock(q: BacklogItem, chips: QueueChip[]): string | undefined {
  if (q.hold) return q.hold.reason
  const waits = chips.find((c) => c.kind === 'depends')
  return waits && (waits.title ?? waits.label)
}

const dispatchQuest = (q: BacklogItem, force = false) => op('Dispatch', () => api().backlogDispatch(q.id, force))
const dropQuest = (q: BacklogItem) => op('Drop', () => api().backlogUpdate(q.id, { state: 'dropped' }))

/** Dispatch and Drop on a standalone quest's card; a plan step has neither (they belong to its plan). */
function QueueActions({ q, chips }: { q: BacklogItem; chips: QueueChip[] }) {
  if (q.planId) return null
  const block = dispatchBlock(q, chips)
  return (
    <div className="qk-foot">
      <span className="qk-actions">
        <button className="btn sm volt" disabled={!!block} title={block} onClick={(e) => { e.stopPropagation(); void dispatchQuest(q) }}>
          <Play size={11} /> Dispatch
        </button>
        <button className="btn sm ghost" onClick={(e) => { e.stopPropagation(); void dropQuest(q) }}>
          <X size={11} /> Drop
        </button>
      </span>
    </div>
  )
}

function QueueTicket({ q, chips, onOpen }: { q: BacklogItem; chips: QueueChip[]; onOpen: () => void }) {
  // a held quest shows its question; the "waiting for you" chip would say the same
  const held = !!q.hold && !q.hold.until
  const shown = held ? chips.filter((c) => c.kind !== 'waiting') : chips
  return (
    <div className={cx('quest qk-ticket panel', q.duplicateOf && 'dup')} onClick={onOpen}>
      <div className="quest-top">
        <span className="quest-title">{q.title}</span>
      </div>
      <TicketMeta q={q} />
      {shown.length > 0 && (
        <div className="quest-meta">
          {shown.map((c, i) => <ReasonChip key={i} c={c} />)}
        </div>
      )}
      {q.hold?.reaction ? <div className="quest-hold"><DislikeMarker /></div>
        : held && <div className="quest-hold"><Hand size={11} /> {trunc(q.hold!.reason, 120)}</div>}
      <QueueActions q={q} chips={chips} />
    </div>
  )
}

function ReasonChip({ c }: { c: QueueChip }) {
  const icon = c.kind === 'waiting' ? <Hand size={10} /> : c.kind === 'depends' ? <Link2 size={10} /> : c.kind === 'duplicate' ? <Copy size={10} />
    : c.kind === 'later' || c.kind === 'quota' ? <Clock size={10} /> : c.kind === 'plan' ? <Pause size={10} /> : null
  return (
    <span className={cx('chip qk-chip', c.tone !== 'mute' && c.tone)} title={c.title}>
      {icon} {trunc(c.label, 48)}{c.date ? ` ${dateShort(c.date)}` : ''}
    </span>
  )
}


/** The kind chip; the project is the window's own. */
function TicketMeta({ q, task }: { q?: BacklogItem; task?: Task }) {
  const kind = q?.kind ?? task?.kind ?? 'ship'
  return (
    <div className="quest-meta">
      {(task?.modeller || q?.modeller) && kind === 'ship' ? (
        <span className="chip orange"><Box size={10} />Modeller</span>
      ) : (task?.generator || q?.generator) && kind === 'ship' ? (
        <span className="chip magenta"><Sparkles size={10} />Generator</span>
      ) : (
        <span className={cx('chip', kind === 'scout' ? 'violet' : kind === 'choice' ? 'amber' : '')}>
          {kind === 'scout' ? <Radar size={10} /> : kind === 'ship' ? <Rocket size={10} /> : <Hand size={10} />}
          {KIND_NAME[kind] ?? kind}
        </span>
      )}
    </div>
  )
}

/** The plan a quest is a step of, while the plan is known to this window. */
function questPlan(plans: WorkPlan[] | undefined, q: BacklogItem): { plan: WorkPlan; step: PlanStep } | undefined {
  return q.planId && plans?.length ? planStepOf(plans, q.id) : undefined
}

// ------------------------------------------------------------------ in flight

function progressLine(task?: Task, events?: StatusEvent[]): string {
  // Genio's own bookkeeping notes (helper runs, claims, node_modules) are not progress.
  const last = [...(events ?? [])].reverse().find((e) => e.kind !== 'unknown' && playerStatusText(e)?.trim())
  return (last && playerStatusText(last)) || task?.stateReason || (task?.lastOutputAt ? 'working' : 'standing by')
}

function FlightTicket({ c, events, onOpen }: { c: FlightCard; events?: StatusEvent[]; onOpen: () => void }) {
  const { quest: q, task: t } = c
  const failed = c.state === 'FAILED'
  const color = toneColor(c.tone)
  return (
    <div className={cx('quest qk-ticket qk-flight panel', failed && 'failed', c.attention && 'attention')} style={{ ['--c' as string]: color }} onClick={onOpen}>
      <div className="quest-top">
        <span className="quest-title">{q?.title ?? t?.title}</span>
      </div>
      <div className="qk-state">
        <span className="dot" style={{ ['--c' as string]: color }} />
        <span className="qk-state-label" style={{ color }}>{failed ? (t ? `UNIT ${t.state.toUpperCase()}` : 'UNIT MISSING') : c.state}</span>
        {c.attention && <NeedsYou className="qk-chip" />}
      </div>
      {failed ? (
        <div className="qk-progress mute">
          {t ? (t.stateReason ?? 'The unit ended without landing').replace(/[.\s]*$/, '.') : 'Its unit is gone.'}
        </div>
      ) : t && statusWorthShowing(t, !!c.attention) && (
        // The unit's words only when it needs the player or is stuck; the state chip says the rest.
        <div className="qk-progress mute" title={progressLine(t, events)}>{trunc(progressLine(t, events), 140)}</div>
      )}
      <TicketMeta q={q} task={t} />
      {(t?.dislikePause || q?.hold?.reaction) ? <div className="quest-hold"><DislikeMarker /></div>
        : q?.hold && <div className="quest-hold"><Hand size={11} /> {trunc(q.hold.reason, 120)}</div>}
      <div className="qk-foot">
        {t && (
          <button className="link-btn" onClick={(e) => { e.stopPropagation(); focusTask(t.id) }}>
            Unit →
          </button>
        )}
        {failed && q && !q.planId && (
          <span className="qk-actions">
            <button className="btn sm ghost" onClick={(e) => { e.stopPropagation(); void dropQuest(q) }}>
              <X size={11} /> Drop
            </button>
          </span>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ done

function DoneTicket({ d, onOpen }: { d: DoneEntry; onOpen: () => void }) {
  const t = d.task
  const color = toneColor(d.tone)
  // a Choice's outcome is the decision; any other outcome repeats the badge
  const outcomeText = d.quest?.kind === 'choice' && d.quest.outcome && !/^https:\/\//.test(d.quest.outcome) ? d.quest.outcome : undefined
  return (
    <div className="quest qk-ticket qk-done panel" style={{ ['--c' as string]: color }} onClick={onOpen}>
      <div className="quest-top">
        <span className="qk-outcome" style={{ color }}>{d.outcome}</span>
        <span className="quest-title">{d.title}</span>
      </div>
      <div className="qk-foot mute">
        <span>{dateShort(d.at)} {clock(d.at)}</span>
      </div>
      {outcomeText && <div className="quest-outcome mute">{trunc(outcomeText, 120)}</div>}
      <div className="qk-foot">
        {t?.pr?.url ? (
          <button className="link-btn" onClick={(e) => { e.stopPropagation(); void api().openExternal(t.pr!.url) }}>
            <ExternalLink size={11} /> PR{t.pr.number ? ` #${t.pr.number}` : ''}
          </button>
        ) : d.quest?.outcome && /^https:\/\//.test(d.quest.outcome) ? (
          <button className="link-btn" onClick={(e) => { e.stopPropagation(); void api().openExternal(d.quest!.outcome!) }}>
            <ExternalLink size={11} /> link
          </button>
        ) : null}
        {t && (
          <button className="link-btn" onClick={(e) => { e.stopPropagation(); focusTask(t.id) }}>
            Unit →
          </button>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ details

/**
 * Read-only apart from Drop, Dispatch and Priority on a standalone quest (a plan step's belong to its plan);
 * the player asks Genio in the chat for any other change.
 */
function QuestDetails({ item, chips, onClose }: { item: BacklogItem; chips: QueueChip[]; onClose: () => void }) {
  const all = useStore((s) => s.snap.backlog)
  const task = useStore((s) => (item.taskId ? s.snap.tasks.find((t) => t.id === item.taskId) : undefined))
  const [confirmEarly, setConfirmEarly] = useState(false)
  // a quest that waits on unlanded work starts only on an explicit second click
  const waitsOn = chips.find((c) => c.kind === 'depends')
  const dup = item.duplicateOf ? all.find((b) => b.id === item.duplicateOf) : undefined
  const closed = item.state === 'done' || item.state === 'dropped'
  const controls = !item.planId && !closed
  // the hold and duplicate boxes below already say what their chips would
  const why = chips.filter((c) => !(item.hold && (c.kind === 'waiting' || c.kind === 'later')) && !(dup && c.kind === 'duplicate'))
  const outcomeUrl = item.outcome && /^https:\/\//.test(item.outcome) ? item.outcome : undefined
  const prUrl = task?.pr?.url

  return (
    <Modal
      kicker={closed ? item.state : item.state === 'in-flight' ? 'in flight' : 'queued'}
      title={item.title}
      onClose={onClose}
      width={680}
      footer={(controls || task || prUrl || outcomeUrl) && (
        <>
          {controls && (
            <button className="btn ghost" onClick={() => void dropQuest(item).then((r) => r && onClose())}>
              <X size={13} /> Drop
            </button>
          )}
          {prUrl ? (
            <button className="link-btn" onClick={() => void api().openExternal(prUrl)}>
              <ExternalLink size={11} /> PR{task?.pr?.number ? ` #${task.pr.number}` : ''}
            </button>
          ) : outcomeUrl && (
            <button className="link-btn" onClick={() => void api().openExternal(outcomeUrl)}>
              <ExternalLink size={11} /> link
            </button>
          )}
          <span style={{ flex: 1 }} />
          {task && (
            <button className="link-btn" onClick={() => { onClose(); focusTask(task.id) }}>
              Unit →
            </button>
          )}
          {controls && (item.state === 'queued' || item.state === 'blocked') && !item.hold && (waitsOn && !confirmEarly ? (
            <button className="btn ghost" onClick={() => setConfirmEarly(true)}>
              <Play size={13} /> Dispatch anyway…
            </button>
          ) : (
            <button className="btn volt" onClick={() => void dispatchQuest(item, Boolean(waitsOn)).then((r) => r?.ok && onClose())}>
              <Play size={13} /> {waitsOn ? 'Start before it lands' : 'Dispatch'}
            </button>
          ))}
        </>
      )}
    >
      {(item.hold || dup || why.length > 0) && !closed && (
        <div className="qk-why">
          {why.length > 0 && <div className="quest-meta">{why.map((c, i) => <ReasonChip key={i} c={c} />)}</div>}
          {item.hold && (
            <div className="hold-box">
              <div>
                <div className="label amber-text">{item.hold.reaction ? <DislikeMarker /> : item.hold.until ? `Later · ${dateShort(item.hold.until)}` : 'Waiting for you'}</div>
                <div>{item.hold.reason}</div>
                {item.answer && <div className="mute">Your words: “{item.answer}”</div>}
              </div>
            </div>
          )}
          {dup && (
            <div className="hold-box">
              <div>
                <div className="label amber-text">Possible duplicate</div>
                <div>Same title as “{dup.title}” ({dup.state}).</div>
              </div>
            </div>
          )}
        </div>
      )}
      {item.summary && (
        <div className="qk-summary">
          <div className="label">What the unit will do</div>
          <p className="dim">{item.summary}</p>
        </div>
      )}
      <div className="form-grid">
        <Field label="Kind">
          <TicketMeta q={item} task={task} />
        </Field>
        <Field label="Priority">
          {controls ? (
            <select className="select" value={item.priority}
              onChange={(e) => void op('Priority', () => api().backlogUpdate(item.id, { priority: e.target.value as Priority }))}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          ) : (
            <span className={cx('prio-label', `p-${item.priority}`)}>{PRIORITY_LABEL[item.priority]}</span>
          )}
        </Field>
      </div>
      {item.notes.trim() && (
        <div className="qk-summary">
          <div className="label">Notes</div>
          <p className="dim">{item.notes}</p>
        </div>
      )}
      {item.outcome && !outcomeUrl && (
        <div className="qk-summary">
          <div className="label">Outcome</div>
          <p className="dim">{item.outcome}</p>
        </div>
      )}
    </Modal>
  )
}
