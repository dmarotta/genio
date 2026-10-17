import { useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Box, Check, Clock, Copy, ExternalLink, Hand, Link2, Pause, Play, Radar, RotateCcw, Rocket, Sparkles, X } from 'lucide-react'
import type { BacklogItem, BacklogKind, PlanStep, Priority, StatusEvent, Task, WorkPlan } from '@shared/types'
import { planGroups, planStepOf, planSummary } from '@shared/work-plan'
import { PlanChip, usePlanView } from '../components/PlanChip'
import { PRIORITIES } from '@shared/api'
import {
  buildBoard, queueChips, reorderQueue, visibleBands, type DoneEntry, type FlightCard, type QueueChip
} from '@shared/quest-board'
import type { SquadTone } from '@shared/squad-display'
import { playerStatusText, statusWorthShowing } from '@shared/unit-page'
import { api, errText, focusTask, op, toast, useStore } from '../store'
import { DislikeMarker, Empty, Field, Modal, NeedsYou, ViewHeader, useNow } from '../components/ui'
import { clock, cx, dateShort, trunc } from '../lib/format'
import { useUsagePolicy } from '../components/PlanMeter'
import { useScreenContext } from '../lib/screen-context'

const DONE_PAGE = 12
const DONE_MORE = 25

const PRIORITY_LABEL: Record<Priority, string> = { critical: 'Critical', high: 'High', normal: 'Normal', low: 'Low' }
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
  const [title, setTitle] = useState('')
  /** 'modeller' and 'generator' file a Build quest with that flag. */
  const [kind, setKind] = useState<BacklogKind | 'modeller' | 'generator'>('ship')
  const [openId, setOpenId] = useState<string | null>(null)
  const [doneShown, setDoneShown] = useState(DONE_PAGE)

  const board = useMemo(() => buildBoard({ backlog: items, tasks, terminals, decisions, now }), [items, tasks, terminals, decisions, now])
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

  const add = async (): Promise<void> => {
    if (!title.trim()) return
    try {
      // The window's project is applied by the main process.
      await api().backlogAdd({ title: title.trim(), priority: 'normal', ...(kind === 'modeller' ? { kind: 'ship', modeller: true } : kind === 'generator' ? { kind: 'ship', generator: true } : { kind }) })
      setTitle('')
    } catch (e) {
      toast('error', 'Quest not added', errText(e))
    }
  }

  const open = (q?: BacklogItem, t?: Task): void => {
    if (q) setOpenId(q.id)
    else if (t) focusTask(t.id)
  }
  const openQuest = openId ? items.find((b) => b.id === openId) : undefined
  const total = board.queued.length + board.inFlight.length
  const columnOf = (q: BacklogItem): string =>
    board.queued.includes(q) ? 'Queued' : board.inFlight.some((c) => c.quest === q) ? 'In flight' : 'Done'
  useScreenContext('quests', { facts: [
    { label: 'Board', value: `${board.queued.length} queued · ${board.inFlight.length} in flight · ${board.done.length} done` },
    openQuest && { label: 'Quest', value: `${openQuest.title} [${openQuest.id}] · ${columnOf(openQuest)} · ${openQuest.priority} · ${openQuest.kind}` },
    !!title.trim() && { label: 'Drafting', value: title }
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
      <div className="quest-add panel ticks">
        <input
          className="input bare"
          placeholder="New quest"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
        />
        <select className="select compact" value={kind} onChange={(e) => setKind(e.target.value as BacklogKind | 'modeller' | 'generator')}>
          <option value="ship">Build</option>
          <option value="modeller">Modeller</option>
          <option value="generator">Generator</option>
          <option value="scout">Recon</option>
          <option value="choice">Choice</option>
        </select>
        <button className="btn solid" disabled={!title.trim()} onClick={() => void add()}>
          Add
        </button>
      </div>

      {total === 0 && board.done.length === 0 ? (
        <Empty title="No quests yet." />
      ) : (
        <div className="kanban qk">
          <QueuedColumn queue={board.queued} plans={plans} chipsFor={chipsFor} onOpen={(q) => open(q)} />
          <section className="kan-col col-in-flight">
            <header className="kan-head">
              <span className="label">In flight</span>
            </header>
            <div className="kan-list">
              {board.inFlight.length === 0 && <div className="qk-empty mute">No units on the field.</div>}
              {planGroups(board.inFlight, (c) => (c.quest ? questPlan(plans, c.quest) : undefined)).map((b) => 'item' in b ? (
                <FlightTicket key={b.item.key} c={b.item} events={b.item.task ? statusByTask[b.item.task.id] : undefined} onOpen={() => open(b.item.quest, b.item.task)} />
              ) : (
                <PlanGroup key={`plan-${b.plan.id}`} plan={b.plan}>
                  {b.items.map((c) => (
                    <FlightTicket key={c.key} c={c} events={c.task ? statusByTask[c.task.id] : undefined} onOpen={() => open(c.quest, c.task)} />
                  ))}
                </PlanGroup>
              ))}
            </div>
          </section>
          <section className="kan-col col-done">
            <header className="kan-head">
              <span className="label">Done</span>
            </header>
            <div className="kan-list">
              {board.done.length === 0 && <div className="qk-empty mute">Nothing finished yet.</div>}
              {board.done.slice(0, doneShown).map((d) => (
                <DoneTicket key={d.key} d={d} onOpen={() => open(d.quest, d.task)} />
              ))}
              {board.done.length > doneShown && (
                <button className="btn ghost sm qk-more" onClick={() => setDoneShown((n) => n + DONE_MORE)}>
                  Show more
                </button>
              )}
            </div>
          </section>
        </div>
      )}
      {openQuest && <QuestDetails item={openQuest} chips={chipsFor(openQuest)} onClose={() => setOpenId(null)} />}
    </div>
  )
}

// ------------------------------------------------------------------ queued

export function QueuedColumn({ queue: all, plans, chipsFor, onOpen }: {
  queue: BacklogItem[]; plans?: WorkPlan[]; chipsFor: (q: BacklogItem) => QueueChip[]; onOpen: (q: BacklogItem) => void
}) {
  // a plan's steps start in plan order, not by priority: they sit in their plan's group above the bands
  const groups = planGroups(all, (q) => questPlan(plans, q)).filter((b) => 'plan' in b)
  const queue = all.filter((q) => !questPlan(plans, q))
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<{ band: Priority; before?: string } | null>(null)
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
  const drop = (band: Priority, before?: string): void => {
    const id = drag
    end()
    if (!id || id === before) return
    const patches = reorderQueue(queue, id, band, before)
    if (patches.length) void op('Priority', () => api().backlogReorder(patches))
  }
  const allow = (band: Priority, before?: string) => (e: DragEvent): void => {
    if (!drag) return
    e.preventDefault()
    e.stopPropagation()
    if (over?.band !== band || over.before !== before) setOver({ band, before })
  }

  return (
    <section className="kan-col col-queued">
      <header className="kan-head">
        <span className="label">Queued</span>
      </header>
      <div className="kan-list">
        {all.length === 0 && <div className="qk-empty mute">Nothing queued</div>}
        {groups.map((g) => 'plan' in g && (
          <PlanGroup key={`plan-${g.plan.id}`} plan={g.plan}>
            {g.items.map((q) => <QueueTicket key={q.id} q={q} chips={chipsFor(q)} onOpen={() => onOpen(q)} />)}
          </PlanGroup>
        ))}
        {visibleBands(queue, !!drag).map((band) => {
          const list = queue.filter((q) => q.priority === band)
          return (
            <div
              key={band}
              className={cx('qk-band', `p-${band}`, !list.length && 'vacant', over?.band === band && !over.before && 'drop-end')}
              onDragOver={allow(band)}
              onDrop={(e) => { e.preventDefault(); drop(band, over?.band === band ? over.before : undefined) }}
            >
              <div className="qk-band-head">
                <span className={cx('prio-label', `p-${band}`)}>{PRIORITY_LABEL[band]}</span>
                {!list.length && <span className="qk-drop mute">Drop here</span>}
              </div>
              {list.map((q) => (
                <div
                  key={q.id}
                  draggable
                  className={cx('qk-drag', drag === q.id && 'dragging', over?.before === q.id && 'drop-before')}
                  onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', q.id); start(q.id) }}
                  onDragEnd={end}
                  onDragOver={allow(band, q.id)}
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


/** The kind chip: a plan step sits in its plan's group, and the project is the window's own. */
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

/** A plan's steps in one column, under "New Play · plan · 1/3 merged". The title opens the plan popover. */
function PlanGroup({ plan, children }: { plan: WorkPlan; children: ReactNode }) {
  const v = usePlanView(plan.id)
  return (
    <div className="qk-plan">
      <div className="qk-plan-head">
        <PlanChip plan={plan} />
        {v && <span className="mute">{planSummary(v)}</span>}
      </div>
      {children}
    </div>
  )
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
        {failed && q && (
          <span className="qk-actions">
            <button className="btn sm amber" onClick={(e) => { e.stopPropagation(); void op('Re-queue', () => api().backlogUpdate(q.id, { state: 'queued' })) }}>
              <RotateCcw size={11} /> Re-queue
            </button>
            <button className="btn sm ghost" onClick={(e) => { e.stopPropagation(); void op('Drop', () => api().backlogUpdate(q.id, { state: 'dropped' })) }}>
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

function QuestDetails({ item, chips, onClose }: { item: BacklogItem; chips: QueueChip[]; onClose: () => void }) {
  const all = useStore((s) => s.snap.backlog)
  const [title, setTitle] = useState(item.title)
  const [notes, setNotes] = useState(item.notes)
  const [priority, setPriority] = useState<Priority>(item.priority)
  const [kind, setKind] = useState<BacklogKind>(item.kind === 'program' ? 'choice' : item.kind)
  const [confirmEarly, setConfirmEarly] = useState(false)
  // a quest that waits on unlanded work starts only on an explicit second click
  const waitsOn = chips.find((c) => c.kind === 'depends')
  const dup = item.duplicateOf ? all.find((b) => b.id === item.duplicateOf) : undefined
  const closed = item.state === 'done' || item.state === 'dropped'
  // the hold and duplicate boxes below already say what their chips would
  const why = chips.filter((c) => !(item.hold && (c.kind === 'waiting' || c.kind === 'later')) && !(dup && c.kind === 'duplicate'))

  const save = async (): Promise<void> => {
    const r = await op('Quest', () =>
      api().backlogUpdate(item.id, { title: title.trim() || item.title, notes, priority, kind })
    )
    if (r) onClose()
  }

  return (
    <Modal
      kicker={closed ? item.state : item.state === 'in-flight' ? 'in flight' : 'queued'}
      title={item.title}
      onClose={onClose}
      width={680}
      footer={
        <>
          {!closed && (
            <button className="btn ghost" onClick={() => void op('Drop', () => api().backlogUpdate(item.id, { state: 'dropped' })).then((r) => r && onClose())}>
              <X size={13} /> Drop
            </button>
          )}
          {closed && (
            <button className="btn ghost" onClick={() => void op('Re-queue', () => api().backlogUpdate(item.id, { state: 'queued' })).then((r) => r && onClose())}>
              <RotateCcw size={13} /> Re-queue
            </button>
          )}
          <span style={{ flex: 1 }} />
          {(item.state === 'queued' || item.state === 'blocked') && !item.hold && (waitsOn && !confirmEarly ? (
            <button className="btn ghost" onClick={() => setConfirmEarly(true)}>
              <Play size={13} /> Dispatch anyway…
            </button>
          ) : (
            <button className="btn volt"
              onClick={() => void op('Dispatch', () => api().backlogDispatch(item.id, Boolean(waitsOn))).then((r) => r?.ok && onClose())}>
              <Play size={13} /> {waitsOn ? 'Start before it lands' : 'Dispatch'}
            </button>
          ))}
          <button className="btn solid" onClick={() => void save()}>
            Save
          </button>
        </>
      }
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
              <button className="btn amber" onClick={() => void op('Ready', () => api().backlogRelease(item.id))}>
                <Check size={13} /> Clear wait
              </button>
            </div>
          )}
          {dup && (
            <div className="hold-box">
              <div>
                <div className="label amber-text">Possible duplicate</div>
                <div>Same title as “{dup.title}” ({dup.state}).</div>
              </div>
              <button className="btn amber" onClick={() => void op('Duplicate', () => api().backlogUpdate(item.id, { duplicateOf: '' }))}>
                <Check size={13} /> Not a duplicate
              </button>
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
        <Field label="Title" wide>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Kind">
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value as BacklogKind)}>
            <option value="ship">Build</option>
            <option value="scout">Recon</option>
            <option value="choice">Choice</option>
          </select>
        </Field>
        <Field label="Priority">
          <select className="select" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Notes" wide>
          <textarea className="textarea" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
