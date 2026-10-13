import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft, CircleStop, ExternalLink, FolderOpen, GitMerge, LogOut, Play, Radar, RotateCcw, Rocket, Send,
  ShieldCheck, SquareTerminal, Trash, ArrowUpFromLine, X
} from 'lucide-react'
import type { Task, TerminalInfo, ValidationStep, Verdict } from '@shared/types'
import { categoryLabel } from '@shared/dispatch'
import type { TaskFile } from '@shared/api'
import { api, errText, focusTask, op, openDeploy, setState, toast, runningUnits, useStore } from '../store'
import { TerminalView } from '../components/Terminal'
import { Markdown } from '../components/Markdown'
import { Chip, Confirm, Dot, Empty, Modal, Field, Tabs, ViewHeader, useNow } from '../components/ui'
import { GenioCore } from '../components/GenioCore'
import { LoadoutReasons, RATEABLE, VerdictButtons, VerdictPick, rateThenMerge } from '../components/Dispatch'
import { KIND_LABEL, MODE_LABEL, STATE_LABEL, isActive, stateTone } from '../lib/vocab'
import { ago, clock, cx, elapsed, shortPath } from '../lib/format'
import { playSfx } from '../lib/sfx'

export function Squad() {
  const focus = useStore((s) => s.focus)
  if (focus?.type === 'task') return <UnitDetail id={focus.id} />
  if (focus?.type === 'terminal') return <SessionDetail id={focus.id} />
  return <SquadGrid />
}

function SquadGrid() {
  const tasks = useStore((s) => s.snap.tasks)
  const terminals = useStore((s) => s.terminals)
  const [showAll, setShowAll] = useState(false)
  const list = useMemo(
    () =>
      tasks
        .filter((t) => showAll || t.state !== 'cleaned')
        .sort((a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt)),
    [tasks, showAll]
  )
  const sessions = Object.values(terminals).filter((t) => t.kind !== 'worker')
  const live = useStore(runningUnits)
  return (
    <div className="view">
      <ViewHeader
        kicker={`${live} in action · ${list.length} on the roster`}
        title={
          <>
            The <span className="accent">Squad</span>
          </>
        }
      >
        <label className="toggle">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          <span className="track" />
          <span className="label">Show despawned</span>
        </label>
        <button className="btn ghost" onClick={() => void api().terminalOpenShell().then((t) => setState({ focus: { type: 'terminal', id: t.id } })).catch((e) => toast('error', 'Shell', errText(e)))}>
          <SquareTerminal size={14} /> Shell
        </button>
        <button className="btn solid" onClick={() => openDeploy()}>
          <Rocket size={14} /> Deploy
        </button>
      </ViewHeader>

      {list.length === 0 ? (
        <Empty icon={<GenioCore size={84} />} title="No units on the field">
          Deploy a Build to ship a change, or a Recon to investigate. Or just tell Genio what you want in Comms.
          <div style={{ marginTop: 16 }}>
            <button className="btn solid" onClick={() => openDeploy()}>
              <Rocket size={14} /> Deploy a unit
            </button>
          </div>
        </Empty>
      ) : (
        <div className="unit-grid">
          {list.map((t) => (
            <UnitCard key={t.id} t={t} term={t.terminalId ? terminals[t.terminalId] : undefined} />
          ))}
        </div>
      )}

      {sessions.length > 0 && (
        <>
          <div className="section-label label">Sessions</div>
          <div className="session-strip">
            {sessions.map((s) => (
              <SessionCard key={s.id} s={s} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function rank(t: Task): number {
  const order: Record<string, number> = { 'needs-decision': 0, blocked: 1, failed: 1, stale: 1, ready: 2, working: 3, spawning: 3, validating: 3, paused: 4, exited: 5, detached: 5, merged: 6, done: 7, cleaned: 9 }
  return order[t.state] ?? 8
}

function UnitCard({ t, term }: { t: Task; term?: TerminalInfo }) {
  const now = useNow(1000)
  const tone = stateTone(t.state)
  const recon = t.kind === 'scout'
  return (
    <article className={cx('unit-card panel', `tone-${tone}`, recon && 'recon')}>
      <header className="unit-head" onClick={() => focusTask(t.id)}>
        <div className="unit-kind">
          {recon ? <Radar size={14} /> : <Rocket size={14} />}
          <span>{KIND_LABEL[t.kind]}</span>
        </div>
        <div className="unit-title-wrap">
          <div className="unit-title">{t.title}</div>
          <div className="unit-sub mute" title={t.loadout?.join('\n')}>
            {t.project} · {t.harness}
            {t.model ? ` · ${t.model}` : ''}
            {t.category ? ` · ${categoryLabel(t.category)}` : ''}
          </div>
        </div>
        <div className="unit-state">
          <Chip tone={tone} pulse={isActive(t.state)}>
            {STATE_LABEL[t.state]}
          </Chip>
          <span className="mono mute">{elapsed(t.createdAt, now)}</span>
        </div>
      </header>
      <div className="unit-term" onDoubleClick={() => focusTask(t.id)}>
        {term && term.alive ? (
          <TerminalView id={term.id} fontSize={11} />
        ) : (
          <NoSignal t={t} />
        )}
      </div>
      <footer className="unit-foot">
        <span className="mute unit-reason" title={t.stateReason}>
          {t.stateReason || (t.lastOutputAt ? `last output ${ago(t.lastOutputAt, now)} ago` : 'standing by')}
        </span>
        {t.pr?.url && (
          <a className="chip neon" onClick={() => void api().openExternal(t.pr!.url)}>
            PR{t.pr.number ? ` #${t.pr.number}` : ''} {t.pr.checks && t.pr.checks !== 'none' ? `· ${t.pr.checks}` : ''}
          </a>
        )}
        {RATEABLE.includes(t.state) && <VerdictButtons t={t} label={false} />}
        <button className="btn sm ghost" onClick={() => focusTask(t.id)}>
          Open
        </button>
      </footer>
    </article>
  )
}

function NoSignal({ t }: { t: Task }) {
  const canRespawn = t.state !== 'cleaned' && t.state !== 'merged' && !(t.kind === 'scout' && t.state === 'done')
  return (
    <div className="no-signal">
      <div className="no-signal-noise" />
      <div className="no-signal-text">
        <div className="label">{t.state === 'cleaned' ? 'Despawned' : 'No signal'}</div>
        <div className="mute" style={{ fontSize: 12 }}>
          {t.state === 'detached' ? 'Genio restarted; the isolated copy is intact.' : t.state === 'cleaned' ? 'Record kept for history.' : 'Unit process is not running.'}
        </div>
        {canRespawn && (
          <button className="btn sm" onClick={(e) => { e.stopPropagation(); void op('Respawn', () => api().controlTask(t.id, 'relaunch')) }}>
            <RotateCcw size={12} /> Respawn
          </button>
        )}
      </div>
    </div>
  )
}

function SessionCard({ s }: { s: TerminalInfo }) {
  return (
    <div className="session-card panel" onClick={() => setState({ focus: { type: 'terminal', id: s.id } })}>
      <SquareTerminal size={14} className={s.kind === 'playtest' ? 'volt-text' : 'neon-text'} />
      <div className="session-main">
        <div className="session-title">{s.title}</div>
        <div className="mute mono" style={{ fontSize: 11 }}>
          {s.kind} · {shortPath(s.cwd)} {s.alive ? '' : `· exited ${s.exitCode ?? ''}`}
        </div>
      </div>
      <button
        className="btn ghost sm icon"
        title="Close"
        onClick={(e) => {
          e.stopPropagation()
          void api().terminalKill(s.id)
        }}
      >
        <X size={13} />
      </button>
    </div>
  )
}

function SessionDetail({ id }: { id: string }) {
  const s = useStore((st) => st.terminals[id])
  if (!s) {
    return (
      <div className="view">
        <button className="btn ghost" onClick={() => setState({ focus: null })}>
          <ArrowLeft size={14} /> Squad
        </button>
        <Empty title="Session closed" />
      </div>
    )
  }
  return (
    <div className="view detail">
      <header className="detail-head">
        <button className="btn ghost sm" onClick={() => setState({ focus: null })}>
          <ArrowLeft size={14} /> Squad
        </button>
        <div className="detail-title">
          <div className="label">{s.kind}</div>
          <h1 className="title" style={{ fontSize: 24 }}>
            {s.title}
          </h1>
        </div>
        <div className="view-actions">
          <span className="mono mute">{s.cwd}</span>
          <button className="btn sm ghost" onClick={() => void api().openPath(s.cwd)}>
            <FolderOpen size={13} /> Folder
          </button>
          <button className="btn sm alert" onClick={() => void api().terminalKill(s.id).then(() => setState({ focus: null }))}>
            <X size={13} /> Close
          </button>
        </div>
      </header>
      <div className="detail-term full panel">
        <TerminalView id={s.id} fontSize={13} autoFocus />
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ unit detail

type TabId = 'brief' | 'timeline' | 'pings' | 'diff' | 'report' | 'gauntlet'

function UnitDetail({ id }: { id: string }) {
  const t = useStore((s) => s.snap.tasks.find((x) => x.id === id))
  const term = useStore((s) => (t?.terminalId ? s.terminals[t.terminalId] : undefined))
  const project = useStore((s) => s.snap.projects.find((p) => p.name === t?.project))
  const settings = useStore((s) => s.settings)
  const [tab, setTab] = useState<TabId>('brief')
  const [ping, setPing] = useState('')
  const [confirm, setConfirm] = useState<null | 'despawn' | 'force' | 'merge' | 'recall'>(null)
  const [refusal, setRefusal] = useState('')
  const [upgrade, setUpgrade] = useState(false)
  const [crew, setCrew] = useState('')
  const [verdict, setVerdict] = useState<Verdict | undefined>()
  const now = useNow(1000)

  useEffect(() => {
    if (t?.kind === 'scout' && (t.state === 'done' || t.reportPath)) setTab('report')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    if (!t) return
    let alive = true
    const poll = (): void => {
      void api().crewState(t.id).then((s) => alive && setCrew(s)).catch(() => undefined)
    }
    poll()
    const iv = window.setInterval(poll, 10_000)
    return () => {
      alive = false
      window.clearInterval(iv)
    }
  }, [t?.id, t?.state]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!t) {
    return (
      <div className="view">
        <button className="btn ghost" onClick={() => setState({ focus: null })}>
          <ArrowLeft size={14} /> Squad
        </button>
        <Empty title="Unit not found">It may belong to an ally base that is offline.</Empty>
      </div>
    )
  }

  const tone = stateTone(t.state)
  const recon = t.kind === 'scout'
  const live = !!term?.alive
  const canMerge = t.kind === 'ship' && (t.state === 'ready' || !!t.pr?.url)

  const sendPing = async (): Promise<void> => {
    const text = ping.trim()
    if (!text) return
    const r = await op('Ping', () => api().sendToTask(t.id, text))
    if (r?.ok) {
      setPing('')
      playSfx('send', settings)
    }
  }

  const despawn = async (force: boolean): Promise<void> => {
    try {
      const r = await api().cleanupTask(t.id, force)
      if (r.ok) {
        toast('success', 'Despawned', r.message)
        setState({ focus: null })
      } else {
        setRefusal(r.message)
        setConfirm('force')
      }
    } catch (e) {
      toast('error', 'Despawn failed', errText(e))
    }
  }

  return (
    <div className="view detail">
      <header className="detail-head">
        <button className="btn ghost sm" onClick={() => setState({ focus: null })}>
          <ArrowLeft size={14} /> Squad
        </button>
        <div className="detail-title">
          <div className="detail-kicker">
            <span className={cx('chip', recon ? 'violet' : 'neon')}>
              {recon ? <Radar size={11} /> : <Rocket size={11} />} {KIND_LABEL[t.kind]}
            </span>
            <Chip tone={tone} pulse={isActive(t.state)}>
              {STATE_LABEL[t.state]}
            </Chip>
            {t.mode && <span className="chip">{MODE_LABEL[t.mode]}</span>}
            {t.yolo && <span className="chip volt">Auto-loot</span>}
            <span className="mono mute">{elapsed(t.createdAt, now)}</span>
            {RATEABLE.includes(t.state) && <VerdictButtons t={t} />}
          </div>
          <h1 className="title" style={{ fontSize: 26 }}>
            {t.title}
          </h1>
          <div className="mute detail-sub">
            {t.project} · <span className="mono">{t.branch}</span> → <span className="mono">{t.baseBranch}</span> · {t.harness}
            {t.model ? `/${t.model}` : ''}
            {t.effort ? ` · ${t.effort}` : ''}
            {t.category ? ` · ${categoryLabel(t.category)}` : ''}
            {t.relaunches ? ` · respawned ×${t.relaunches}` : ''}
          </div>
        </div>
        {t.pr?.url && (
          <button className="btn" onClick={() => void api().openExternal(t.pr!.url)}>
            <ExternalLink size={13} /> PR{t.pr.number ? ` #${t.pr.number}` : ''}
            {t.pr.checks && t.pr.checks !== 'none' && <span className={cx('chip', t.pr.checks === 'passing' ? 'volt' : t.pr.checks === 'failing' ? 'alert' : 'amber')}>{t.pr.checks}</span>}
          </button>
        )}
      </header>

      <div className="detail-toolbar">
        <div className="tb-group">
          <button className="btn sm" disabled={!live} title="Send Esc to stop the current turn" onClick={() => void op('Interrupt', () => api().controlTask(t.id, 'interrupt'))}>
            <CircleStop size={13} /> Interrupt
          </button>
          <button className="btn sm" disabled={!live} title="Exit the agent cleanly (keeps the isolated copy)" onClick={() => setConfirm('recall')}>
            <LogOut size={13} /> Recall
          </button>
          <button className="btn sm" disabled={t.state === 'cleaned'} title="Restart the agent in the same copy, resuming its conversation" onClick={() => void op('Respawn', () => api().controlTask(t.id, 'relaunch'))}>
            <RotateCcw size={13} /> Respawn
          </button>
        </div>
        <div className="tb-group">
          <button className="btn sm volt" disabled={t.state === 'cleaned' || !project?.commands.run} title={project?.commands.run ? `Run: ${project.commands.run}` : 'Set a run command in Projects'} onClick={() => void op('Playtest', () => api().playtest({ taskId: t.id }), (r) => (r ? 'Playtest launched in Sessions' : undefined))}>
            <Play size={13} /> Playtest
          </button>
          {t.kind === 'ship' && (
            <button className="btn sm" disabled={t.state === 'cleaned' || t.state === 'validating'} title="Run the Gauntlet: review, checks, push, PR" onClick={() => void op('Gauntlet', () => api().validateTask(t.id))}>
              <ShieldCheck size={13} /> Gauntlet
            </button>
          )}
          {canMerge && (
            <button className="btn sm solid volt" disabled={project?.gitRepo === false} title={project?.gitRepo === false ? 'Merge needs a git repo' : undefined} onClick={() => setConfirm('merge')}>
              <GitMerge size={13} /> Merge
            </button>
          )}
          {recon && t.state !== 'cleaned' && (
            <button className="btn sm violet" onClick={() => setUpgrade(true)}>
              <ArrowUpFromLine size={13} /> Upgrade to Build
            </button>
          )}
        </div>
        <div className="tb-group">
          <button className="btn sm ghost" disabled={t.state === 'cleaned'} onClick={() => void api().openPath(t.worktree)}>
            <FolderOpen size={13} /> Folder
          </button>
          <button className="btn sm ghost" disabled={t.state === 'cleaned'} onClick={() => void api().terminalOpenShell(t.worktree).then((s) => setState({ focus: { type: 'terminal', id: s.id } })).catch((e) => toast('error', 'Shell', errText(e)))}>
            <SquareTerminal size={13} /> Shell
          </button>
          <button className="btn sm alert" disabled={t.state === 'cleaned'} onClick={() => setConfirm('despawn')}>
            <Trash size={13} /> Despawn
          </button>
        </div>
      </div>

      <div className="detail-body">
        <div className="detail-term panel">
          {term && term.alive ? <TerminalView id={term.id} fontSize={13} autoFocus /> : <NoSignal t={t} />}
        </div>
        <aside className="detail-side panel">
          {crew && <div className="crew-state mono">{crew}</div>}
          <LoadoutReasons t={t} />
          <Tabs<TabId>
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'brief', label: 'Brief' },
              { id: 'timeline', label: 'Timeline' },
              { id: 'pings', label: 'Pings' },
              { id: 'diff', label: 'Diff' },
              ...(recon ? [{ id: 'report' as TabId, label: 'Report' }] : []),
              ...(!recon ? [{ id: 'gauntlet' as TabId, label: 'Gauntlet' }] : [])
            ]}
          />
          <div className="detail-tab">
            <TaskFileTab t={t} tab={tab} />
          </div>
          <div className="ping-box">
            <textarea
              className="textarea"
              rows={2}
              value={ping}
              disabled={t.state === 'cleaned'}
              placeholder="Ping this unit — lands in its durable inbox"
              onChange={(e) => setPing(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void sendPing()
              }}
            />
            <button className="btn solid icon" disabled={!ping.trim()} onClick={() => void sendPing()} title="Ping (Ctrl+Enter)">
              <Send size={14} />
            </button>
          </div>
        </aside>
      </div>

      {confirm === 'despawn' && (
        <Confirm
          title="Despawn this unit?"
          tone="alert"
          confirmLabel="Despawn"
          body={
            <>
              Genio removes the isolated copy only if nothing would be lost: no uncommitted changes, and the work is pushed, merged, or already in{' '}
              <span className="mono">{t.baseBranch}</span>. Otherwise it refuses and tells you why.
            </>
          }
          onConfirm={() => despawn(false)}
          onClose={() => setConfirm((c) => (c === 'despawn' ? null : c))}
        />
      )}
      {confirm === 'force' && (
        <Confirm
          title="Despawn refused"
          tone="alert"
          typed="DISCARD"
          confirmLabel="Force despawn"
          body={
            <>
              <pre className="refusal selectable">{refusal}</pre>
              <p>Forcing throws away this unit's unlanded work for good. Only do this if you really mean to discard it.</p>
            </>
          }
          onConfirm={() => despawn(true)}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === 'merge' && (
        <Confirm
          title="Merge this Build?"
          tone="volt"
          confirmLabel="Merge"
          body={
            <>
              {t.pr?.url ? (
                <>
                  Squash-merge <a onClick={() => void api().openExternal(t.pr!.url)}>{t.pr.url}</a> into <span className="mono">{t.baseBranch}</span>. Genio refuses drafts, conflicts, and anything not green.
                </>
              ) : (
                <>
                  Fast-forward <span className="mono">{t.branch}</span> into <span className="mono">{t.baseBranch}</span> in your local copy of {t.project}.
                </>
              )}
              <VerdictPick value={verdict ?? t.verdict} onChange={setVerdict} />
            </>
          }
          onConfirm={async () => {
            const r = await rateThenMerge(t.id, verdict)
            if (r?.ok) playSfx('merge', settings)
          }}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === 'recall' && (
        <Confirm
          title="Recall this unit?"
          tone="amber"
          confirmLabel="Recall"
          body="The agent exits cleanly. Its isolated copy and work stay put; respawn any time."
          onConfirm={async () => {
            await op('Recall', () => api().controlTask(t.id, 'exit'))
          }}
          onClose={() => setConfirm(null)}
        />
      )}
      {upgrade && <UpgradeModal t={t} onClose={() => setUpgrade(false)} />}
    </div>
  )
}

function UpgradeModal({ t, onClose }: { t: Task; onClose: () => void }) {
  const [intent, setIntent] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      kicker="Upgrade to Build"
      title={t.title}
      tone="violet"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn solid violet"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                const nt = await api().promoteScout(t.id, intent.trim() || undefined)
                toast('success', 'Upgraded to Build', nt.title)
                onClose()
                focusTask(nt.id)
              } catch (e) {
                toast('error', 'Upgrade refused', errText(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            <ArrowUpFromLine size={14} /> Upgrade
          </button>
        </>
      }
    >
      <p className="dim">The Recon's report becomes the context for a Build in the same isolated copy. Say what you want built from it.</p>
      <Field label="Your words (optional)">
        <textarea className="textarea" rows={4} value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="Implement the recommended fix…" />
      </Field>
    </Modal>
  )
}

const FILE_FOR: Record<TabId, TaskFile> = {
  brief: 'brief',
  timeline: 'status',
  pings: 'inbox',
  diff: 'diff',
  report: 'report',
  gauntlet: 'validation'
}

function TaskFileTab({ t, tab }: { t: Task; tab: TabId }) {
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const statusLive = useStore((s) => s.statusByTask[t.id]?.length ?? 0)
  useEffect(() => {
    let alive = true
    setErr('')
    const load = (): void => {
      void api()
        .readTaskFile(t.id, FILE_FOR[tab])
        .then((s) => alive && setText(s))
        .catch((e) => alive && (setErr(errText(e)), setText('')))
    }
    setText(null)
    load()
    const iv = tab === 'diff' || tab === 'gauntlet' || tab === 'pings' ? window.setInterval(load, 8000) : undefined
    return () => {
      alive = false
      if (iv) window.clearInterval(iv)
    }
  }, [t.id, tab, statusLive, t.state, t.validation?.state])

  if (text === null) return <div className="bar indeterminate"><i /></div>
  if (err) return <div className="alert-text mono" style={{ fontSize: 12 }}>{err}</div>

  switch (tab) {
    case 'brief':
    case 'report':
      return text.trim() ? <Markdown text={text} className="md-compact" /> : <div className="mute">{tab === 'report' ? 'No report yet. The Recon writes it before declaring done.' : 'No brief.'}</div>
    case 'timeline':
      return <Timeline raw={text} />
    case 'pings':
      return text.trim() ? <pre className="file-pre selectable">{text}</pre> : <div className="mute">No pings sent yet.</div>
    case 'diff':
      return text.trim() ? <Diff text={text} /> : <div className="mute">No changes on this branch yet.</div>
    case 'gauntlet':
      return <Gauntlet t={t} log={text} />
  }
}

const VERB_TONE: Record<string, string> = {
  working: 'neon',
  'needs-decision': 'amber',
  blocked: 'alert',
  failed: 'alert',
  paused: 'mute',
  done: 'volt',
  resolved: 'mute',
  note: 'mute',
  'player-held': 'amber'
}

function Timeline({ raw }: { raw: string }) {
  const rows = raw
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      const m = l.match(/^\s*([a-z-]+)((?:\s*\[[^\]]*\])*)\s*:\s*(.*)$/i)
      if (!m) return { verb: 'note', tags: '', text: l, at: undefined as number | undefined }
      const at = m[2].match(/\[at=(\d{1,12})\]/)
      return { verb: m[1].toLowerCase(), tags: m[2].replace(/\[at=\d+\]/, '').trim(), text: m[3], at: at ? parseInt(at[1], 10) : undefined }
    })
    .reverse()
  if (!rows.length) return <div className="mute">No status reported yet.</div>
  return (
    <div className="timeline">
      {rows.map((r, i) => (
        <div key={i} className="tl-row">
          <span className={cx('tl-verb', VERB_TONE[r.verb] ?? 'mute')}>{r.verb}</span>
          <div className="tl-text selectable">
            {r.tags && <span className="mono mute">{r.tags} </span>}
            {r.text}
          </div>
          <span className="mono mute tl-time">{r.at ? clock(new Date(r.at * 1000).toISOString()) : ''}</span>
        </div>
      ))}
    </div>
  )
}

function Diff({ text }: { text: string }) {
  const lines = text.split(/\r?\n/).slice(0, 4000)
  return (
    <pre className="diff selectable">
      {lines.map((l, i) => (
        <div
          key={i}
          className={cx(
            l.startsWith('+++') || l.startsWith('---') ? 'd-file' : l.startsWith('+') ? 'd-add' : l.startsWith('-') ? 'd-del' : l.startsWith('@@') ? 'd-hunk' : l.startsWith('diff ') || l.startsWith('# ---') ? 'd-head' : ''
          )}
        >
          {l || ' '}
        </div>
      ))}
    </pre>
  )
}

function Gauntlet({ t, log }: { t: Task; log: string }) {
  const v = t.validation
  const icon = (s: ValidationStep['state']): string => ({ pending: '○', running: '◐', passed: '●', failed: '✕', skipped: '–' })[s]
  const toneOf = (s: ValidationStep['state']): string => ({ pending: 'mute', running: 'neon', passed: 'volt', failed: 'alert', skipped: 'mute' })[s]
  return (
    <div className="gauntlet">
      {!v ? (
        <div className="mute">
          {t.mode === 'no-mistakes' ? 'The Gauntlet runs automatically when the unit declares done.' : 'Not run. Hit GAUNTLET to validate this Build on demand.'}
        </div>
      ) : (
        <>
          <div className="g-head">
            <span className={cx('chip', v.state === 'passed' ? 'volt' : v.state === 'running' ? 'neon' : v.state === 'findings' ? 'amber' : 'alert')}>{v.state}</span>
            <span className="mute">Round {v.round}</span>
            <span className="mono mute">{clock(v.startedAt)}</span>
          </div>
          <div className="g-steps">
            {v.steps.map((s, i) => (
              <div key={i} className={cx('g-step', s.state)}>
                <span className={cx('g-light', toneOf(s.state))}>{icon(s.state)}</span>
                <span className="g-name">{s.name}</span>
                {s.command && <span className="mono mute g-cmd">{s.command}</span>}
              </div>
            ))}
          </div>
          {v.findings && (
            <div className="g-findings">
              <div className="label">Findings</div>
              <Markdown text={v.findings} className="md-compact" />
            </div>
          )}
        </>
      )}
      {log.trim() && (
        <details className="g-log">
          <summary className="label">Log</summary>
          <pre className="file-pre selectable">{log.slice(-20000)}</pre>
        </details>
      )}
    </div>
  )
}

