import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ArrowLeft, CircleStop, ExternalLink, FolderOpen, GitMerge, LogOut, Radar, RotateCcw, Rocket, Send,
  SquareTerminal, Trash, ArrowUpFromLine, X
} from 'lucide-react'
import type { Task, TerminalInfo, ValidationStep, Verdict } from '@shared/types'
import { categoryLabel } from '@shared/dispatch'
import type { TaskFile } from '@shared/api'
import { api, errText, focusTask, op, openDeploy, setState, toast, liveTasks, useStore } from '../store'
import { TerminalView } from '../components/Terminal'
import { Markdown } from '../components/Markdown'
import { Chip, Confirm, DislikeMarker, Dot, Empty, Modal, Field, NeedsYou, Tabs, ViewHeader, useNow } from '../components/ui'
import { GenioCore } from '../components/GenioCore'
import { LoadoutReasons, RATEABLE, VerdictButtons, VerdictPick, rateThenMerge } from '../components/Dispatch'
import { KIND_LABEL, MODE_LABEL } from '../lib/vocab'
import { ago, clock, cx, shortPath } from '../lib/format'
import { playSfx } from '../lib/sfx'
import { squadAttention, squadBadge, squadState, squadTone, unitClock } from '@shared/squad-display'
import { UNIT_ACTION_HINT, canRespawn, hasOpenPr } from '@shared/unit-actions'
import { pendingDecision } from '@shared/decisions'
import { listFact, useScreenContext } from '../lib/screen-context'

export function Squad() {
  const focus = useStore((s) => s.focus)
  if (focus?.type === 'task') return <UnitDetail id={focus.id} />
  if (focus?.type === 'terminal') return <SessionDetail id={focus.id} />
  return <SquadGrid />
}

function SquadGrid() {
  const tasks = useStore(liveTasks)
  const terminals = useStore((s) => s.terminals)
  const list = useMemo(
    () =>
      [...tasks]
        .sort((a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt)),
    [tasks]
  )
  const sessions = Object.values(terminals).filter((t) => t.kind !== 'worker')
  useScreenContext('squad', { facts: [
    { label: 'Roster', value: `${list.length} active units` },
    list.length > 0 && { label: 'Units', value: listFact(list.map((t) => `${t.title} (${squadState(t, t.terminalId ? terminals[t.terminalId] : undefined)})`), list.length, 5) }
  ] })
  return (
    <div className="view">
      <ViewHeader
        kicker={`${list.length} active units`}
        title={
          <>
            The <span className="accent">Squad</span>
          </>
        }
      >
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
  const pending = useStore(s => s.snap.decisions.some(d => d.taskId === t.id && pendingDecision(d, now)))
  const tone = squadTone(t, term)
  const badge = squadBadge(t, term)
  const attention = squadAttention(t, term, pending)
  const recon = t.kind === 'scout'
  return (
    <article className={cx('unit-card panel', `tone-${tone}`, recon && 'recon', attention && 'attention')}>
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
          <Chip tone={badge.tone} pulse={badge.label === 'WORKING'}>
            {badge.label}
          </Chip>
          {attention && <NeedsYou />}
          {t.dislikePause && <DislikeMarker />}
          <span className="mono mute">{unitClock(t, term, now)}</span>
        </div>
      </header>
      <div className="unit-term" onDoubleClick={() => focusTask(t.id)}>
        {term && term.alive ? (
          <TerminalView id={term.id} fontSize={11} passive interactive={false} />
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

/** A Squad card whose agent is not running. The unit page has no such panel: its content takes the space. */
function NoSignal({ t }: { t: Task }) {
  return (
    <div className="no-signal">
      <div className="no-signal-noise" />
      <div className="no-signal-text">
        <div className="label">{t.state === 'cleaned' ? 'Despawned' : 'No signal'}</div>
        <div className="mute" style={{ fontSize: 12 }}>
          {t.state === 'detached' ? 'Genio restarted; the isolated copy is intact.' : t.state === 'cleaned' ? 'Record kept for history.' : 'Unit process is not running.'}
        </div>
        {canRespawn(t) && (
          <button className="btn sm" title={UNIT_ACTION_HINT.respawn} onClick={(e) => { e.stopPropagation(); void op('Respawn', () => api().controlTask(t.id, 'relaunch')) }}>
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
      <SquareTerminal size={14} className="neon-text" />
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
  useScreenContext('squad', { facts: [{ label: 'Session', value: s ? `${s.title} (${s.kind}) · ${s.cwd}` : `${id} (closed)` }] })
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
/** Under 900 px one pane shows at a time: the terminal or a side tab. */
type PaneId = 'terminal' | TabId

function UnitDetail({ id }: { id: string }) {
  const t = useStore((s) => s.snap.tasks.find((x) => x.id === id))
  const term = useStore((s) => (t?.terminalId ? s.terminals[t.terminalId] : undefined))
  const project = useStore((s) => s.snap.projects.find((p) => p.name === t?.project))
  const settings = useStore((s) => s.settings)
  const [tab, setTab] = useState<TabId>('brief')
  const [pane, setPane] = useState<'terminal' | 'side'>('terminal')
  const [ping, setPing] = useState('')
  const [confirm, setConfirm] = useState<null | 'despawn' | 'force' | 'merge' | 'recall'>(null)
  const [refusal, setRefusal] = useState('')
  const [upgrade, setUpgrade] = useState(false)
  const [verdict, setVerdict] = useState<Verdict | undefined>()
  const now = useNow(1000)
  const latest = useStore((s) => s.statusByTask[id]?.at(-1))
  useScreenContext('squad', { facts: t ? [
    { label: 'Unit', value: `${t.title} [${t.id}]` },
    { label: 'State', value: `${squadBadge(t, term).label} (${t.state}) · ${KIND_LABEL[t.kind]} · ${t.branch}` },
    { label: 'Tab', value: tab },
    latest && { label: 'Last status', value: `${latest.kind}: ${latest.text}` }
  ] : [{ label: 'Unit', value: `${id} (gone)` }] })

  const pending = useStore(s => s.snap.decisions.some(d => d.taskId === id && pendingDecision(d, now)))

  useEffect(() => {
    if (t?.kind === 'scout' && (t.state === 'done' || t.reportPath)) {
      setTab('report')
      setPane('side')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

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

  const badge = squadBadge(t, term)
  const attention = squadAttention(t, term, pending)
  const recon = t.kind === 'scout'
  const live = !!term?.alive
  const cleaned = t.state === 'cleaned'
  const canMerge = t.kind === 'ship' && (t.state === 'ready' || !!t.pr?.url)
  const tabs: { id: TabId; label: string }[] = [
    { id: 'brief', label: 'Brief' },
    { id: 'timeline', label: 'Timeline' },
    { id: 'pings', label: 'Pings' },
    { id: 'diff', label: 'Diff' },
    recon ? { id: 'report', label: 'Report' } : { id: 'gauntlet', label: 'Gauntlet' }
  ]
  const shown: PaneId = term && pane === 'terminal' ? 'terminal' : tab
  const showPane = (p: PaneId): void => {
    setPane(p === 'terminal' ? 'terminal' : 'side')
    if (p !== 'terminal') setTab(p)
  }

  // One flat list so a later layout (primary action, More menu) can regroup it.
  const actions: (UnitAction | false)[] = [
    { id: 'interrupt', group: 'control', label: 'Interrupt', icon: <CircleStop size={13} />, hint: UNIT_ACTION_HINT.interrupt, disabled: !live,
      run: () => void op('Interrupt', () => api().controlTask(t.id, 'interrupt')) },
    { id: 'recall', group: 'control', label: 'Recall', icon: <LogOut size={13} />, hint: UNIT_ACTION_HINT.recall, disabled: !live, run: () => setConfirm('recall') },
    { id: 'respawn', group: 'control', label: 'Respawn', icon: <RotateCcw size={13} />, hint: UNIT_ACTION_HINT.respawn, disabled: !canRespawn(t),
      run: () => void op('Respawn', () => api().controlTask(t.id, 'relaunch')) },
    canMerge && { id: 'merge', group: 'deliver', label: 'Merge', icon: <GitMerge size={13} />, className: 'solid volt', disabled: project?.gitRepo === false,
      hint: project?.gitRepo === false ? 'Merge needs a git repo' : `Lands ${t.branch} in ${t.baseBranch}`, run: () => setConfirm('merge') },
    recon && !cleaned && { id: 'upgrade', group: 'deliver', label: 'Upgrade to Build', icon: <ArrowUpFromLine size={13} />, className: 'violet',
      hint: "Builds from this Recon's report in the same copy", run: () => setUpgrade(true) },
    { id: 'folder', group: 'copy', label: 'Folder', icon: <FolderOpen size={13} />, className: 'ghost', disabled: cleaned, hint: "Opens the unit's copy in Explorer",
      run: () => void api().openPath(t.worktree) },
    { id: 'shell', group: 'copy', label: 'Shell', icon: <SquareTerminal size={13} />, className: 'ghost', disabled: cleaned, hint: UNIT_ACTION_HINT.shell,
      run: () => void api().terminalOpenShell(undefined, t.id).then((s) => setState({ focus: { type: 'terminal', id: s.id } })).catch((e) => toast('error', 'Shell', errText(e))) },
    { id: 'despawn', group: 'copy', label: 'Despawn', icon: <Trash size={13} />, className: 'alert', disabled: cleaned, hint: UNIT_ACTION_HINT.despawn, run: () => setConfirm('despawn') }
  ]

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
            <Chip tone={badge.tone} pulse={badge.label === 'WORKING'}>
              {badge.label}
            </Chip>
            {attention && <NeedsYou />}
            {t.dislikePause && <DislikeMarker />}
            {t.mode && <span className="chip">{MODE_LABEL[t.mode]}</span>}
            {t.yolo && <span className="chip volt">Auto-loot</span>}
            {t.landedCommit && <span className="chip volt mono selectable" title={t.landedCommit}>commit {t.landedCommit.slice(0, 10)}</span>}
            <span className="mono mute detail-clock">{unitClock(t, term, now)}</span>
            {RATEABLE.includes(t.state) && <VerdictButtons t={t} />}
          </div>
          <h1 className="title unit-name" title={t.title}>
            {t.title}
          </h1>
          <div className="mute detail-sub">
            {t.project} · <span className="mono">{t.branch}</span> → <span className="mono">{t.baseBranch}</span> · {t.harness}
            {t.model ? `/${t.model}` : ''}
            {t.effort ? ` · ${t.effort}` : ''}
            {t.category ? ` · ${categoryLabel(t.category)}` : ''}
            {t.relaunches ? ` · respawned ×${t.relaunches}` : ''}
          </div>
          {t.stateReason && <div className={cx('detail-reason', badge.tone === 'alert' ? 'alert-text' : 'mute')} title={t.stateReason}>{t.stateReason}</div>}
        </div>
        {t.pr?.url && (
          <button className="btn detail-pr" onClick={() => void api().openExternal(t.pr!.url)}>
            <ExternalLink size={13} /> PR{t.pr.number ? ` #${t.pr.number}` : ''}
            {t.pr.checks && t.pr.checks !== 'none' && <span className={cx('chip', t.pr.checks === 'passing' ? 'volt' : t.pr.checks === 'failing' ? 'alert' : 'amber')}>{t.pr.checks}</span>}
          </button>
        )}
      </header>

      <UnitToolbar actions={actions.filter((a): a is UnitAction => !!a)} />

      <div className="detail-switch">
        <Tabs<PaneId> value={shown} onChange={showPane} tabs={[...(term ? [{ id: 'terminal' as PaneId, label: 'Terminal' }] : []), ...tabs]} />
      </div>
      <div className={cx('detail-body', !term && 'no-term', shown === 'terminal' ? 'pane-terminal' : 'pane-side')}>
        {term && (
          <div className="detail-term panel">
            <TerminalView id={term.id} fontSize={13} passive interactive={term.alive} />
          </div>
        )}
        <aside className="detail-side panel">
          <LoadoutReasons t={t} />
          <div className="detail-side-tabs">
            <Tabs<TabId> value={tab} onChange={setTab} tabs={tabs} />
          </div>
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
              {hasOpenPr(t) && (
                <p className="amber-text despawn-pr">
                  PR{t.pr!.number ? ` #${t.pr!.number}` : ''} is still open. After Despawn, Genio stops watching its checks and you can no longer merge it from here; the PR itself stays open.
                </p>
              )}
              <p>
                Genio deletes the isolated copy and its branch, and closes the unit's shells, only if nothing would be lost: no uncommitted changes, and the work is pushed, merged, or already in{' '}
                <span className="mono">{t.baseBranch}</span>. Otherwise it refuses and tells you why.
              </p>
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
          body="The agent exits cleanly and its isolated copy and work stay put. It does not stay stopped: reopening the project respawns it automatically. Despawn it instead if its work is finished."
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

interface UnitAction {
  id: string
  /** Toolbar cluster: lifecycle controls, delivery, the unit's copy. */
  group: 'control' | 'deliver' | 'copy'
  label: string
  icon: ReactNode
  /** One-line consequence, shown on hover. */
  hint: string
  className?: string
  disabled?: boolean
  run: () => void
}

function UnitToolbar({ actions }: { actions: UnitAction[] }) {
  const groups = (['control', 'deliver', 'copy'] as const).map((g) => actions.filter((a) => a.group === g)).filter((g) => g.length)
  return (
    <div className="detail-toolbar">
      {groups.map((g) => (
        <div key={g[0].group} className="tb-group">
          {g.map((a) => (
            <button key={a.id} className={cx('btn sm', a.className)} disabled={a.disabled} title={a.hint} onClick={a.run}>
              {a.icon} <span className="tb-label">{a.label}</span>
            </button>
          ))}
        </div>
      ))}
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
          {t.mode === 'no-mistakes' ? 'The Gauntlet runs automatically when the unit declares done.' : 'Not run. The Gauntlet runs automatically on Hardcore Builds only.'}
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

