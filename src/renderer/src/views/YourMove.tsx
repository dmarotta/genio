import { useEffect, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Clock, ExternalLink, GitMerge, Hand, Play, Sparkles } from 'lucide-react'
import type { Decision, Task, Verdict } from '@shared/types'
import { VerdictPick, rateThenMerge } from '../components/Dispatch'
import { api, focusTask, heldQuests, op, openDecisions, readyTasks, useStore } from '../store'
import { Markdown } from '../components/Markdown'
import { Chip, Confirm, Empty, ViewHeader } from '../components/ui'
import { cx, ago, dateShort } from '../lib/format'
import { MODE_LABEL } from '../lib/vocab'
import { playSfx } from '../lib/sfx'

export function YourMove() {
  const decisions = useStore(openDecisions)
  const ready = useStore(readyTasks)
  const held = useStore(heldQuests)
  const gamertag = useStore((s) => s.settings?.gamertag || 'Player')
  const [idx, setIdx] = useState(0)

  // Sort: urgent first, then oldest first (impact order approximation).
  const sorted = [...decisions].sort((a, b) => (a.urgency === b.urgency ? a.createdAt.localeCompare(b.createdAt) : a.urgency === 'urgent' ? -1 : 1))
  const current = sorted[Math.min(idx, Math.max(0, sorted.length - 1))]

  useEffect(() => {
    if (idx >= sorted.length && sorted.length) setIdx(sorted.length - 1)
  }, [sorted.length, idx])

  const nothing = !sorted.length && !ready.length && !held.length

  return (
    <div className="view">
      <ViewHeader
        kicker={`${sorted.length} choice${sorted.length === 1 ? '' : 's'} · ${ready.length} ready to loot · ${held.length} held`}
        title={
          <>
            Your <span className="accent">Move</span>
          </>
        }
      />
      {nothing ? (
        <Empty icon={<Check size={44} className="volt-text" />} title={`All clear, ${gamertag}`}>
          No choices pending. Genio pings you here the moment something needs your call.
        </Empty>
      ) : (
        <div className="move-layout">
          <div className="move-main">
            {current ? (
              <>
                <div className="move-nav">
                  <span className="label">
                    Choice {Math.min(idx, sorted.length - 1) + 1} / {sorted.length}
                  </span>
                  <div>
                    <button className="btn ghost sm icon" disabled={idx <= 0} onClick={() => setIdx((i) => i - 1)}>
                      <ChevronLeft size={14} />
                    </button>
                    <button className="btn ghost sm icon" disabled={idx >= sorted.length - 1} onClick={() => setIdx((i) => i + 1)}>
                      <ChevronRight size={14} />
                    </button>
                  </div>
                </div>
                <ChoiceCard key={current.id} d={current} />
              </>
            ) : (
              <div className="panel move-none">
                <Check size={18} className="volt-text" /> No open choices.
              </div>
            )}
          </div>
          <aside className="move-side">
            <div className="label section-label">Ready to loot</div>
            {ready.length === 0 && <div className="mute side-empty">Nothing waiting on a merge.</div>}
            {ready.map((t) => (
              <ReadyRow key={t.id} t={t} />
            ))}
            <div className="label section-label">Held quests</div>
            {held.length === 0 && <div className="mute side-empty">No quests on hold.</div>}
            {held.map((b) => (
              <div key={b.id} className="held-row panel">
                <Hand size={14} className="amber-text" />
                <div className="held-main">
                  <div className="held-title">{b.title}</div>
                  <div className="mute">
                    {b.hold?.reason}
                    {b.hold?.until && ` · until ${dateShort(b.hold.until)}`}
                  </div>
                </div>
                <button className="btn sm amber" onClick={() => void op('Release', () => api().backlogRelease(b.id), () => 'Quest released')}>
                  Release
                </button>
              </div>
            ))}
          </aside>
        </div>
      )}
    </div>
  )
}

function ChoiceCard({ d }: { d: Decision }) {
  const task = useStore((s) => (d.taskId ? s.snap.tasks.find((t) => t.id === d.taskId) : undefined))
  const settings = useStore((s) => s.settings)
  const [answer, setAnswer] = useState('')
  const [later, setLater] = useState(false)
  const [until, setUntil] = useState(() => new Date(Date.now() + 86400000).toISOString().slice(0, 10))
  const [busy, setBusy] = useState(false)

  const submit = async (text: string): Promise<void> => {
    if (!text.trim()) return
    setBusy(true)
    const r = await op('Your move', () => api().answerDecision(d.id, text.trim()))
    if (r?.ok) playSfx('decision', settings)
    setBusy(false)
  }

  const sourceLabel: Record<Decision['source'], string> = { unit: 'From a unit', genio: 'From Genio', validation: 'From the Gauntlet', ally: 'From an ally', system: 'System' }

  return (
    <div className={cx('choice panel glow ticks rise', d.urgency === 'urgent' && 'urgent')}>
      <div className="choice-kicker">
        <span className="label amber-text">{sourceLabel[d.source]}</span>
        {d.urgency === 'urgent' && <Chip tone="alert">Urgent</Chip>}
        {d.project && <span className="chip">{d.project}</span>}
        <span className="mono mute">{ago(d.createdAt)} ago</span>
      </div>
      <h2 className="choice-q">{d.question}</h2>
      {task && (
        <button className="link-btn" onClick={() => focusTask(task.id)}>
          {task.title} →
        </button>
      )}
      {d.context && (
        <div className="choice-context">
          <Markdown text={d.context} className="md-compact" />
        </div>
      )}
      {d.options.length > 0 && (
        <div className="choice-options">
          {d.options.map((o, i) => {
            const rec = d.recommendation && (d.recommendation === o || d.recommendation.toLowerCase().startsWith(o.toLowerCase()))
            return (
              <button key={i} className={cx('option', rec && 'rec')} disabled={busy} onClick={() => void submit(o)}>
                <span className="option-key num">{i + 1}</span>
                <span className="option-text">{o}</span>
                {rec && (
                  <span className="chip volt">
                    <Sparkles size={10} /> Recommended
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
      {d.recommendation && !d.options.some((o) => d.recommendation === o || d.recommendation!.toLowerCase().startsWith(o.toLowerCase())) && (
        <div className="choice-rec">
          <Sparkles size={13} className="volt-text" /> <b>Genio recommends:</b> {d.recommendation}
        </div>
      )}
      <div className="choice-answer">
        <textarea
          className="textarea"
          rows={2}
          value={answer}
          placeholder="Or answer in your own words…"
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit(answer)
          }}
        />
        <div className="choice-actions">
          {later ? (
            <>
              <input className="input compact" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
              <button
                className="btn sm"
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
            <button className="btn sm ghost" onClick={() => setLater(true)}>
              <Clock size={13} /> Later
            </button>
          )}
          <button className="btn solid amber" disabled={busy || !answer.trim()} onClick={() => void submit(answer)}>
            Lock in
          </button>
        </div>
      </div>
    </div>
  )
}

function ReadyRow({ t }: { t: Task }) {
  const project = useStore((s) => s.snap.projects.find((p) => p.name === t.project))
  const settings = useStore((s) => s.settings)
  const [confirm, setConfirm] = useState(false)
  const [verdict, setVerdict] = useState<Verdict | undefined>()
  const checks = t.pr?.checks
  return (
    <div className="ready-row panel">
      <div className="ready-main" onClick={() => focusTask(t.id)}>
        <div className="ready-title">{t.title}</div>
        <div className="mute ready-sub">
          {t.project} · {t.mode ? MODE_LABEL[t.mode] : ''} {t.pr?.number ? `· PR #${t.pr.number}` : `· ${t.branch}`}
        </div>
      </div>
      {checks && checks !== 'none' && <span className={cx('chip', checks === 'passing' ? 'volt' : checks === 'failing' ? 'alert' : 'amber')}>{checks}</span>}
      <div className="ready-actions">
        {t.pr?.url && (
          <button className="btn sm ghost icon" title="Open PR" onClick={() => void api().openExternal(t.pr!.url)}>
            <ExternalLink size={13} />
          </button>
        )}
        <button className="btn sm ghost icon" title="Playtest this branch" disabled={!project?.commands.run} onClick={() => void op('Playtest', () => api().playtest({ taskId: t.id }), (r) => (r ? 'Playtest launched' : undefined))}>
          <Play size={13} />
        </button>
        <button className="btn sm solid volt" disabled={checks === 'failing'} onClick={() => setConfirm(true)}>
          <GitMerge size={13} /> Merge
        </button>
      </div>
      {confirm && (
        <Confirm
          title="Merge this Build?"
          tone="volt"
          confirmLabel="Merge"
          body={
            <>
              {t.pr?.url ? `Squash-merge ${t.pr.url}. Genio refuses drafts, conflicts and anything not green.` : `Fast-forward ${t.branch} into ${t.baseBranch} locally.`}
              <VerdictPick value={verdict ?? t.verdict} onChange={setVerdict} />
            </>
          }
          onConfirm={async () => {
            const r = await rateThenMerge(t.id, verdict)
            if (r?.ok) playSfx('merge', settings)
          }}
          onClose={() => setConfirm(false)}
        />
      )}
    </div>
  )
}
