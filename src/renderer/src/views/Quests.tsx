import { useMemo, useState, type DragEvent } from 'react'
import { Check, Clock, Copy, ExternalLink, GitMerge, Hand, Link2, Play, Plus, Radar, RotateCcw, Rocket, Trash, X } from 'lucide-react'
import type { BacklogItem, BacklogKind, Priority, StatusEvent, Task } from '@shared/types'
import { PRIORITIES } from '@shared/api'
import {
  buildBoard, PRIORITY_ORDER, queueChips, reorderQueue, type DoneEntry, type FlightCard, type QueueChip
} from '@shared/quest-board'
import type { SquadTone } from '@shared/squad-display'
import { api, errText, focusTask, op, toast, useStore } from '../store'
import { Confirm, Empty, Field, Modal, ViewHeader, useNow } from '../components/ui'
import { KIND_LABEL } from '../lib/vocab'
import { ago, clock, cx, dateInput, dateShort, duration, trunc } from '../lib/format'
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
  const decisions = useStore((s) => s.snap.decisions)
  const projects = useStore((s) => s.snap.projects)
  const terminals = useStore((s) => s.terminals)
  const statusByTask = useStore((s) => s.statusByTask)
  const policy = useUsagePolicy()
  const now = useNow(30_000)
  const [title, setTitle] = useState('')
  const [project, setProject] = useState('')
  const [kind, setKind] = useState<BacklogKind>('ship')
  const [priority, setPriority] = useState<Priority>('normal')
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
      backlog: items, tasks, terminals, worldCaps, now,
      global: policy ? { cap: policy.unitCap, used: policy.liveUnits } : undefined,
      quota: wait ? { reason: wait.reason, until: wait.until } : undefined
    })
  }
  // the head of the queue is what dispatch picks next; the rest are ready behind it
  const nextUp = board.queued.find((q) => reasons(q)[0]?.kind === 'ready')?.id
  const chipsFor = (q: BacklogItem): QueueChip[] =>
    q.id === nextUp ? reasons(q).map((c) => (c.kind === 'ready' ? { ...c, label: 'next up' } : c)) : reasons(q)

  const add = async (): Promise<void> => {
    if (!title.trim()) return
    try {
      await api().backlogAdd({ title: title.trim(), project: project || undefined, kind, priority })
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
        kicker={`${board.inFlight.length} in flight · ${board.queued.length} queued · ${board.done.length} done`}
        title={
          <>
            Quest <span className="accent">Log</span>
          </>
        }
      />
      <div className="quest-add panel ticks">
        <Plus size={16} className="neon-text" />
        <input
          className="input bare"
          placeholder="New quest — what needs doing?"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
        />
        <select className="select compact" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">Any project</option>
          {projects.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <select className="select compact" value={kind} onChange={(e) => setKind(e.target.value as BacklogKind)}>
          <option value="ship">Build</option>
          <option value="scout">Recon</option>
          <option value="choice">Choice</option>
        </select>
        <select className="select compact" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]}
            </option>
          ))}
        </select>
        <button className="btn solid" disabled={!title.trim()} onClick={() => void add()}>
          Add
        </button>
      </div>

      {total === 0 && board.done.length === 0 ? (
        <Empty icon={<span className="big-glyph">◆</span>} title="Quest log is empty">
          Add quests here, or tell Genio about work in Comms — it files and dispatches them as capacity frees up.
        </Empty>
      ) : (
        <div className="kanban qk">
          <QueuedColumn queue={board.queued} chipsFor={chipsFor} now={now} onOpen={(q) => open(q)} />
          <section className="kan-col col-in-flight">
            <header className="kan-head">
              <span className="label">In flight</span>
              <span className="num">{board.inFlight.length}</span>
            </header>
            <div className="kan-hint mute">The Squad's active units: working or ready to merge</div>
            <div className="kan-list">
              {board.inFlight.length === 0 && <div className="qk-empty mute">No units on the field.</div>}
              {board.inFlight.map((c) => (
                <FlightTicket key={c.key} c={c} now={now} events={c.task ? statusByTask[c.task.id] : undefined} onOpen={() => open(c.quest, c.task)} />
              ))}
            </div>
          </section>
          <section className="kan-col col-done">
            <header className="kan-head">
              <span className="label">Done</span>
              <span className="num">{board.done.length}</span>
            </header>
            <div className="kan-hint mute">Finished quests and units, newest first</div>
            <div className="kan-list">
              {board.done.length === 0 && <div className="qk-empty mute">Nothing finished yet.</div>}
              {board.done.slice(0, doneShown).map((d) => (
                <DoneTicket key={d.key} d={d} onOpen={() => open(d.quest, d.task)} />
              ))}
              {board.done.length > doneShown && (
                <button className="btn ghost sm qk-more" onClick={() => setDoneShown((n) => n + DONE_MORE)}>
                  Show {Math.min(DONE_MORE, board.done.length - doneShown)} more · {board.done.length - doneShown} older
                </button>
              )}
              {doneShown > DONE_PAGE && (
                <button className="link-btn qk-less" onClick={() => setDoneShown(DONE_PAGE)}>
                  Collapse to the last {DONE_PAGE}
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

function QueuedColumn({ queue, chipsFor, now, onOpen }: {
  queue: BacklogItem[]; chipsFor: (q: BacklogItem) => QueueChip[]; now: number; onOpen: (q: BacklogItem) => void
}) {
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<{ band: Priority; before?: string } | null>(null)

  const drop = (band: Priority, before?: string): void => {
    const id = drag
    setDrag(null)
    setOver(null)
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
        <span className="num">{queue.length}</span>
      </header>
      <div className="kan-hint mute">Runs next, top first · drag to reorder or change priority</div>
      <div className="kan-list">
        {PRIORITY_ORDER.map((band) => {
          const list = queue.filter((q) => q.priority === band)
          return (
            <div
              key={band}
              className={cx('qk-band', `p-${band}`, !list.length && 'empty', over?.band === band && !over.before && 'drop-end')}
              onDragOver={allow(band)}
              onDrop={(e) => { e.preventDefault(); drop(band, over?.band === band ? over.before : undefined) }}
            >
              <div className="qk-band-head">
                <span className={cx('prio-label', `p-${band}`)}>{PRIORITY_LABEL[band]}</span>
                <span className="mono mute">{list.length}</span>
              </div>
              {list.map((q) => (
                <div
                  key={q.id}
                  draggable
                  className={cx('qk-drag', drag === q.id && 'dragging', over?.before === q.id && 'drop-before')}
                  onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', q.id); setDrag(q.id) }}
                  onDragEnd={() => { setDrag(null); setOver(null) }}
                  onDragOver={allow(band, q.id)}
                >
                  <QueueTicket q={q} chips={chipsFor(q)} now={now} onOpen={() => onOpen(q)} />
                </div>
              ))}
              {!list.length && <div className="qk-drop mute">{drag ? 'Drop here' : 'none'}</div>}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function QueueTicket({ q, chips, now, onOpen }: { q: BacklogItem; chips: QueueChip[]; now: number; onOpen: () => void }) {
  return (
    <div className={cx('quest qk-ticket panel', q.duplicateOf && 'dup')} onClick={onOpen}>
      <div className="quest-top">
        <PriorityLabel q={q} />
        <span className="quest-title">{q.title}</span>
      </div>
      <TicketMeta q={q} />
      {chips.length > 0 && (
        <div className="quest-meta">
          {chips.map((c, i) => <ReasonChip key={i} c={c} />)}
        </div>
      )}
      {q.hold && !q.hold.until && <div className="quest-hold"><Hand size={11} /> {trunc(q.hold.reason, 120)}</div>}
      {q.answer && <div className="quest-outcome mute">Your words: “{trunc(q.answer, 100)}”</div>}
      <div className="qk-foot mute">
        <span title={q.createdAt}>age {ago(q.createdAt, now)}</span>
        {q.taskId && <span title="Worked on before">· follow-up</span>}
      </div>
    </div>
  )
}

function ReasonChip({ c }: { c: QueueChip }) {
  const icon = c.kind === 'waiting' ? <Hand size={10} /> : c.kind === 'depends' ? <Link2 size={10} /> : c.kind === 'duplicate' ? <Copy size={10} />
    : c.kind === 'later' || c.kind === 'quota' ? <Clock size={10} /> : c.kind === 'ready' ? <Play size={10} /> : null
  return (
    <span className={cx('chip qk-chip', c.tone !== 'mute' && c.tone)} title={c.title}>
      {icon} {trunc(c.label, 48)}{c.date ? ` ${dateShort(c.date)}` : ''}
    </span>
  )
}

/** Click the label to change the priority in place. */
function PriorityLabel({ q }: { q: BacklogItem }) {
  const [menu, setMenu] = useState(false)
  const set = (p: Priority): void => {
    setMenu(false)
    if (p !== q.priority) void op('Priority', () => api().backlogUpdate(q.id, { priority: p }))
  }
  return (
    <span className="prio-wrap" onClick={(e) => e.stopPropagation()}>
      <button className={cx('prio-label', `p-${q.priority}`)} title="Change priority" onClick={() => setMenu((m) => !m)}>
        {PRIORITY_LABEL[q.priority]}
      </button>
      {menu && (
        <span className="prio-menu panel" onMouseLeave={() => setMenu(false)}>
          {PRIORITY_ORDER.map((p) => (
            <button key={p} className={cx('prio-label', `p-${p}`, p === q.priority && 'on')} onClick={() => set(p)}>
              {PRIORITY_LABEL[p]}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}

function TicketMeta({ q, task }: { q?: BacklogItem; task?: Task }) {
  const kind = q?.kind ?? task?.kind ?? 'ship'
  const world = q?.project ?? task?.project
  return (
    <div className="quest-meta">
      <span className={cx('chip', kind === 'scout' ? 'violet' : kind === 'choice' ? 'amber' : '')}>
        {kind === 'scout' ? <Radar size={10} /> : kind === 'ship' ? <Rocket size={10} /> : <Hand size={10} />}
        {KIND_NAME[kind] ?? kind}
      </span>
      {world && <span className="chip">{world}</span>}
      {task?.category && <span className="chip qk-chip">{task.category}</span>}
      {q?.tags.map((t) => <span key={t} className="chip qk-chip qk-tag">#{t}</span>)}
    </div>
  )
}

// ------------------------------------------------------------------ in flight

function progressLine(task?: Task, events?: StatusEvent[]): string {
  const last = [...(events ?? [])].reverse().find((e) => e.kind !== 'unknown' && e.text.trim())
  return last?.text || task?.stateReason || (task?.lastOutputAt ? 'working' : 'standing by')
}

function FlightTicket({ c, now, events, onOpen }: { c: FlightCard; now: number; events?: StatusEvent[]; onOpen: () => void }) {
  const { quest: q, task: t } = c
  const failed = c.state === 'FAILED'
  const color = toneColor(c.tone)
  return (
    <div className={cx('quest qk-ticket qk-flight panel', failed && 'failed', c.attention && 'attention')} style={{ ['--c' as string]: color }} onClick={onOpen}>
      <div className="quest-top">
        {q && <PriorityLabel q={q} />}
        <span className="quest-title">{q?.title ?? t?.title}</span>
      </div>
      <div className="qk-state">
        <span className="dot" style={{ ['--c' as string]: color }} />
        <span className="qk-state-label" style={{ color }}>{failed ? (t ? `UNIT ${t.state.toUpperCase()}` : 'UNIT MISSING') : c.state}</span>
        {c.attention && <span className="chip amber qk-chip"><Hand size={10} /> needs you</span>}
        {t && <span className="mono mute qk-age">{duration(t.createdAt, new Date(now).toISOString())}</span>}
      </div>
      <div className="qk-progress mute" title={progressLine(t, events)}>
        {failed
          ? `${t ? (t.stateReason ?? 'The unit ended without landing').replace(/[.\s]*$/, '.') : 'Its unit is gone.'} Re-queue or drop the quest.`
          : trunc(progressLine(t, events), 140)}
      </div>
      <TicketMeta q={q} task={t} />
      {q?.hold && <div className="quest-hold"><Hand size={11} /> {trunc(q.hold.reason, 120)}</div>}
      <div className="qk-foot">
        {t && (
          <button className="link-btn" onClick={(e) => { e.stopPropagation(); focusTask(t.id) }}>
            View unit →
          </button>
        )}
        {t?.pr?.url && (
          <button className="link-btn" onClick={(e) => { e.stopPropagation(); void api().openExternal(t.pr!.url) }}>
            PR{t.pr.number ? ` #${t.pr.number}` : ''}
          </button>
        )}
        {failed && q && (
          <span className="qk-actions">
            <button className="btn sm amber" onClick={(e) => { e.stopPropagation(); void op('Re-queue', () => api().backlogUpdate(q.id, { state: 'queued' }), () => 'Back in the queue') }}>
              <RotateCcw size={11} /> Re-queue
            </button>
            <button className="btn sm ghost" onClick={(e) => { e.stopPropagation(); void op('Drop', () => api().backlogUpdate(q.id, { state: 'dropped' }), () => 'Quest dropped') }}>
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
  const outcomeText = d.quest?.outcome && !/^https:\/\//.test(d.quest.outcome) ? d.quest.outcome : undefined
  return (
    <div className="quest qk-ticket qk-done panel" style={{ ['--c' as string]: color }} onClick={onOpen}>
      <div className="quest-top">
        <span className="qk-outcome" style={{ color }}>{d.outcome}</span>
        <span className="quest-title">{d.title}</span>
      </div>
      <div className="qk-foot mute">
        <span title={d.at}>{dateShort(d.at)} {clock(d.at)}</span>
        {duration(d.startedAt, d.at) && <span>· took {duration(d.startedAt, d.at)}</span>}
        {(t?.project ?? d.quest?.project) && <span>· {t?.project ?? d.quest?.project}</span>}
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
        ) : t && d.outcome === 'merged' && t.mode === 'local-only' ? (
          <span className="mono mute" title="Fast-forwarded into the local base branch"><GitMerge size={11} /> {t.branch}</span>
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
  const projects = useStore((s) => s.snap.projects)
  const all = useStore((s) => s.snap.backlog)
  const tasks = useStore((s) => s.snap.tasks)
  const [title, setTitle] = useState(item.title)
  const [notes, setNotes] = useState(item.notes)
  const [priority, setPriority] = useState<Priority>(item.priority)
  const [project, setProject] = useState(item.project ?? '')
  const [kind, setKind] = useState<BacklogKind>(item.kind === 'program' ? 'choice' : item.kind)
  const [tags, setTags] = useState(item.tags.join(', '))
  const [deps, setDeps] = useState<string[]>(item.dependsOn)
  const [notBefore, setNotBefore] = useState(dateInput(item.notBefore))
  const [confirmDel, setConfirmDel] = useState(false)
  const units = tasks.filter((t) => t.backlogId === item.id || t.id === item.taskId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const dup = item.duplicateOf ? all.find((b) => b.id === item.duplicateOf) : undefined
  const closed = item.state === 'done' || item.state === 'dropped'

  const save = async (): Promise<void> => {
    const r = await op('Quest', () =>
      api().backlogUpdate(item.id, {
        title: title.trim() || item.title,
        notes,
        priority,
        project: project || undefined,
        kind,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        dependsOn: deps,
        notBefore: notBefore ? new Date(notBefore).toISOString() : undefined
      })
    )
    if (r) onClose()
  }

  return (
    <Modal
      kicker={`Quest · ${item.id} · ${closed ? item.state : item.state === 'in-flight' ? 'in flight' : 'queued'}`}
      title={item.title}
      onClose={onClose}
      width={680}
      footer={
        <>
          <button className="btn alert ghost" onClick={() => setConfirmDel(true)}>
            <Trash size={13} /> Remove
          </button>
          <span style={{ flex: 1 }} />
          {!closed && (
            <button className="btn ghost" onClick={() => void op('Drop', () => api().backlogUpdate(item.id, { state: 'dropped' }), () => 'Quest dropped').then((r) => r && onClose())}>
              <X size={13} /> Drop
            </button>
          )}
          {closed && (
            <button className="btn ghost" onClick={() => void op('Re-queue', () => api().backlogUpdate(item.id, { state: 'queued' }), () => 'Back in the queue').then((r) => r && onClose())}>
              <RotateCcw size={13} /> Re-queue
            </button>
          )}
          {(item.state === 'queued' || item.state === 'blocked') && !item.hold && (
            <button className="btn volt" onClick={() => void op('Dispatch', () => api().backlogDispatch(item.id)).then((r) => r?.ok && onClose())}>
              <Play size={13} /> Dispatch
            </button>
          )}
          <button className="btn solid" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      {(item.hold || dup || chips.length > 0) && !closed && (
        <div className="qk-why">
          {chips.length > 0 && <div className="quest-meta">{chips.map((c, i) => <ReasonChip key={i} c={c} />)}</div>}
          {item.hold && (
            <div className="hold-box">
              <div>
                <div className="label amber-text">{item.hold.until ? `Later · ${dateShort(item.hold.until)}` : 'Waiting for you'}</div>
                <div>{item.hold.reason}</div>
                {item.answer && <div className="mute">Your words: “{item.answer}”</div>}
              </div>
              <button className="btn amber" onClick={() => void op('Ready', () => api().backlogRelease(item.id), () => 'Quest is ready to run')}>
                <Check size={13} /> Clear wait
              </button>
            </div>
          )}
          {dup && (
            <div className="hold-box">
              <div>
                <div className="label amber-text">Possible duplicate</div>
                <div>Same title as “{dup.title}” ({dup.state}). Not dispatched until you decide.</div>
              </div>
              <button className="btn amber" onClick={() => void op('Duplicate', () => api().backlogUpdate(item.id, { duplicateOf: '' }), () => 'Not a duplicate')}>
                <Check size={13} /> Not a duplicate
              </button>
            </div>
          )}
        </div>
      )}
      <div className="form-grid">
        <Field label="Title" wide>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Project">
          <select className="select" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">Any project</option>
            {projects.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
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
        <Field label="Not before">
          <input className="input" type="date" value={notBefore} onChange={(e) => setNotBefore(e.target.value)} />
        </Field>
        <Field label="Labels" wide hint="Comma separated, e.g. workspace, character-sheet">
          <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} />
        </Field>
        <Field label="Depends on" wide hint="This quest waits until these are done.">
          <div className="dep-picker">
            {all
              .filter((b) => b.id !== item.id && b.state !== 'dropped')
              .slice(0, 60)
              .map((b) => (
                <button key={b.id} className={cx('chip dep', deps.includes(b.id) && 'neon')} onClick={() => setDeps((d) => (d.includes(b.id) ? d.filter((x) => x !== b.id) : [...d, b.id]))}>
                  {trunc(b.title, 34)}
                </button>
              ))}
          </div>
        </Field>
        <Field label="Notes" wide>
          <textarea className="textarea" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>

      <hr className="divider" />
      <div className="label">History</div>
      <ul className="qk-history">
        <li><span className="mono mute">{dateShort(item.createdAt)} {clock(item.createdAt)}</span> Filed</li>
        {units.map((t) => (
          <li key={t.id}>
            <span className="mono mute">{dateShort(t.createdAt)} {clock(t.createdAt)}</span>{' '}
            {KIND_LABEL[t.kind]} unit <button className="link-btn" onClick={() => focusTask(t.id)}>{t.id}</button> · {t.state}
            {t.landedAt && ` · landed ${dateShort(t.landedAt)}`}
            {t.pr?.url && <> · <button className="link-btn" onClick={() => void api().openExternal(t.pr!.url)}>PR{t.pr.number ? ` #${t.pr.number}` : ''}</button></>}
          </li>
        ))}
        {closed && (
          <li>
            <span className="mono mute">{dateShort(item.doneAt ?? item.updatedAt)} {clock(item.doneAt ?? item.updatedAt)}</span> {item.state === 'dropped' ? 'Dropped' : 'Done'}
            {item.outcome && <span className="mute"> · {trunc(item.outcome, 200)}</span>}
          </li>
        )}
      </ul>
      {confirmDel && (
        <Confirm
          title="Remove quest?"
          tone="alert"
          confirmLabel="Remove"
          body={`“${item.title}” leaves the Quest Log. Units already deployed keep running.`}
          onConfirm={async () => {
            await op('Remove', () => api().backlogRemove(item.id))
            onClose()
          }}
          onClose={() => setConfirmDel(false)}
        />
      )}
    </Modal>
  )
}
