import { useMemo, useState } from 'react'
import { Clock, Hand, Link2, Pause, Play, Plus, Rocket, Trash, Radar } from 'lucide-react'
import type { BacklogItem, BacklogKind, Priority } from '@shared/types'
import { PRIORITIES } from '@shared/api'
import { api, errText, focusTask, op, toast, useStore } from '../store'
import { Confirm, Empty, Field, Modal, ViewHeader } from '../components/ui'
import { PRIORITY_GLYPH, KIND_LABEL } from '../lib/vocab'
import { clock, cx, dateInput, dateShort, trunc } from '../lib/format'
import { useUsagePolicy } from '../components/PlanMeter'
import type { QuotaWait } from '@shared/usage-mode'

type Col = 'queued' | 'in-flight' | 'held' | 'done'

const COLS: { id: Col; label: string; hint: string }[] = [
  { id: 'queued', label: 'Queued', hint: 'Ready when deps, gates, capacity and plan headroom clear' },
  { id: 'in-flight', label: 'In flight', hint: 'A unit is on it' },
  { id: 'held', label: 'Held', hint: 'Waiting on your move or a date' },
  { id: 'done', label: 'Done', hint: 'Recent loot' }
]

function colOf(b: BacklogItem): Col {
  if (b.state === 'done' || b.state === 'dropped') return 'done'
  if (b.state === 'in-flight') return 'in-flight'
  if (b.state === 'held' || b.hold) return 'held'
  return 'queued'
}

const prioRank: Record<Priority, number> = { critical: 0, high: 1, normal: 2, low: 3 }

export function Quests() {
  const items = useStore((s) => s.snap.backlog)
  const projects = useStore((s) => s.snap.projects)
  const [title, setTitle] = useState('')
  const [project, setProject] = useState('')
  const [kind, setKind] = useState<BacklogKind>('ship')
  const [priority, setPriority] = useState<Priority>('normal')
  const [edit, setEdit] = useState<BacklogItem | null>(null)
  const policy = useUsagePolicy()
  const waits = useMemo(() => new Map((policy?.waiting ?? []).map((w) => [w.id, w.wait])), [policy])

  const byCol = useMemo(() => {
    const m: Record<Col, BacklogItem[]> = { queued: [], 'in-flight': [], held: [], done: [] }
    for (const b of items) m[colOf(b)].push(b)
    for (const c of ['queued', 'in-flight', 'held'] as Col[]) m[c].sort((a, b) => prioRank[a.priority] - prioRank[b.priority] || a.createdAt.localeCompare(b.createdAt))
    m.done.sort((a, b) => (b.doneAt ?? b.updatedAt).localeCompare(a.doneAt ?? a.updatedAt))
    m.done = m.done.slice(0, 25)
    return m
  }, [items])

  const add = async (): Promise<void> => {
    if (!title.trim()) return
    try {
      await api().backlogAdd({ title: title.trim(), project: project || undefined, kind, priority })
      setTitle('')
    } catch (e) {
      toast('error', 'Quest not added', errText(e))
    }
  }

  const open = items.filter((b) => b.state !== 'done' && b.state !== 'dropped').length

  return (
    <div className="view">
      <ViewHeader
        kicker={`${open} open quests`}
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
          <option value="">Any world</option>
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
          <option value="program">Program</option>
        </select>
        <select className="select compact" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_GLYPH[p].glyph} {PRIORITY_GLYPH[p].label}
            </option>
          ))}
        </select>
        <button className="btn solid" disabled={!title.trim()} onClick={() => void add()}>
          Add
        </button>
      </div>

      {items.length === 0 ? (
        <Empty icon={<span className="big-glyph">◆</span>} title="Quest log is empty">
          Add quests here, or tell Genio about work in Comms — it files and dispatches them as capacity frees up.
        </Empty>
      ) : (
        <div className="kanban">
          {COLS.map((c) => (
            <section key={c.id} className={cx('kan-col', `col-${c.id}`)}>
              <header className="kan-head">
                <span className="label">{c.label}</span>
                <span className="num">{byCol[c.id].length}</span>
              </header>
              <div className="kan-hint mute">{c.hint}</div>
              <div className="kan-list">
                {byCol[c.id].map((b) => (
                  <QuestCard key={b.id} b={b} all={items} wait={waits.get(b.id)} onEdit={() => setEdit(b)} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      {edit && <QuestEditor item={edit} onClose={() => setEdit(null)} />}
    </div>
  )
}

function QuestCard({ b, all, wait, onEdit }: { b: BacklogItem; all: BacklogItem[]; wait?: QuotaWait; onEdit: () => void }) {
  const pg = PRIORITY_GLYPH[b.priority]
  const deps = b.dependsOn.map((d) => all.find((x) => x.id === d)).filter(Boolean) as BacklogItem[]
  const openDeps = deps.filter((d) => d.state !== 'done')
  const kindIcon = b.kind === 'scout' ? <Radar size={11} /> : b.kind === 'ship' ? <Rocket size={11} /> : null
  return (
    <div className={cx('quest panel', b.state === 'blocked' && 'blocked', b.state === 'dropped' && 'dropped')} onClick={onEdit}>
      <div className="quest-top">
        <span className="quest-prio" style={{ color: `var(--${pg.tone === 'mute' ? 'text-mute' : pg.tone})` }} title={pg.label}>
          {pg.glyph}
        </span>
        <span className="quest-title">{b.title}</span>
      </div>
      <div className="quest-meta">
        <span className={cx('chip', b.kind === 'scout' ? 'violet' : b.kind === 'choice' ? 'amber' : '')}>
          {kindIcon}
          {b.kind === 'ship' || b.kind === 'scout' ? KIND_LABEL[b.kind] : b.kind}
        </span>
        {b.project && <span className="chip">{b.project}</span>}
        {openDeps.length > 0 && (
          <span className="chip alert" title={openDeps.map((d) => d.title).join(', ')}>
            <Link2 size={10} /> needs {openDeps.length}
          </span>
        )}
        {b.notBefore && new Date(b.notBefore) > new Date() && (
          <span className="chip">
            <Clock size={10} /> {dateShort(b.notBefore)}
          </span>
        )}
      </div>
      {wait && (
        <div className="quest-hold quota-wait" title={wait.reason}>
          <Clock size={11} /> Queued until reset{wait.until ? ` · ${clock(wait.until)}` : ': waiting for fresh plan evidence'}
          <div className="mute">{trunc(wait.reason, 120)}</div>
        </div>
      )}
      {b.hold && (
        <div className="quest-hold">
          <Hand size={11} /> {trunc(b.hold.reason, 120)}
          {b.hold.until && <span className="mute"> · until {dateShort(b.hold.until)}</span>}
        </div>
      )}
      {b.outcome && <div className="quest-outcome mute">{trunc(b.outcome, 120)}</div>}
      {b.taskId && (
        <button
          className="link-btn"
          onClick={(e) => {
            e.stopPropagation()
            focusTask(b.taskId!)
          }}
        >
          View unit →
        </button>
      )}
    </div>
  )
}

function QuestEditor({ item, onClose }: { item: BacklogItem; onClose: () => void }) {
  const projects = useStore((s) => s.snap.projects)
  const all = useStore((s) => s.snap.backlog)
  const live = useStore((s) => s.snap.backlog.find((b) => b.id === item.id)) ?? item
  const [title, setTitle] = useState(item.title)
  const [notes, setNotes] = useState(item.notes)
  const [priority, setPriority] = useState<Priority>(item.priority)
  const [project, setProject] = useState(item.project ?? '')
  const [kind, setKind] = useState<BacklogKind>(item.kind)
  const [deps, setDeps] = useState<string[]>(item.dependsOn)
  const [notBefore, setNotBefore] = useState(dateInput(item.notBefore))
  const [holdReason, setHoldReason] = useState('')
  const [holdUntil, setHoldUntil] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)

  const save = async (): Promise<void> => {
    const r = await op('Quest', () =>
      api().backlogUpdate(item.id, {
        title: title.trim() || item.title,
        notes,
        priority,
        project: project || undefined,
        kind,
        dependsOn: deps,
        notBefore: notBefore ? new Date(notBefore).toISOString() : undefined
      })
    )
    if (r) onClose()
  }

  const isHeld = live.state === 'held' || !!live.hold
  const canDispatch = live.state === 'queued' || live.state === 'blocked'

  return (
    <Modal
      kicker={`Quest · ${item.id}`}
      title={live.title}
      onClose={onClose}
      width={640}
      footer={
        <>
          <button className="btn alert ghost" onClick={() => setConfirmDel(true)}>
            <Trash size={13} /> Remove
          </button>
          <span style={{ flex: 1 }} />
          {canDispatch && (
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
      <div className="form-grid">
        <Field label="Title" wide>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="World">
          <select className="select" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">Any world</option>
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
            <option value="program">Program</option>
          </select>
        </Field>
        <Field label="Priority">
          <select className="select" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_GLYPH[p].glyph} {PRIORITY_GLYPH[p].label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Not before">
          <input className="input" type="date" value={notBefore} onChange={(e) => setNotBefore(e.target.value)} />
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
      {isHeld ? (
        <div className="hold-box">
          <div>
            <div className="label amber-text">Held</div>
            <div>{live.hold?.reason}</div>
            {live.hold?.until && <div className="mute">until {dateShort(live.hold.until)}</div>}
            {live.answer && <div className="mute">Your answer: “{live.answer}”</div>}
          </div>
          <button className="btn amber" onClick={() => void op('Release', () => api().backlogRelease(item.id), () => 'Quest released')}>
            <Play size={13} /> Release
          </button>
        </div>
      ) : (
        <div className="hold-form">
          <Field label="Hold for">
            <input className="input" value={holdReason} placeholder="Reason, e.g. waiting on art pass" onChange={(e) => setHoldReason(e.target.value)} />
          </Field>
          <Field label="Until (optional)">
            <input className="input" type="date" value={holdUntil} onChange={(e) => setHoldUntil(e.target.value)} />
          </Field>
          <button
            className="btn amber"
            disabled={!holdReason.trim()}
            onClick={() => void op('Hold', () => api().backlogHold(item.id, holdReason.trim(), holdUntil ? new Date(holdUntil).toISOString() : undefined), () => 'Quest held')}
          >
            <Pause size={13} /> Hold
          </button>
        </div>
      )}
      {confirmDel && (
        <Confirm
          title="Remove quest?"
          tone="alert"
          confirmLabel="Remove"
          body={`“${live.title}” leaves the Quest Log. Units already deployed keep running.`}
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
