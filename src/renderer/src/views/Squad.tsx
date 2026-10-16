import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Archive, ArrowLeft, ChevronDown, ExternalLink, FolderOpen, GitMerge, Info, MoreHorizontal, Play as PlayIcon, RotateCcw, Rocket, Send,
  SquareTerminal, ArrowUpFromLine, X
} from 'lucide-react'
import type { Decision, Task, TerminalInfo, ValidationStep, Verdict } from '@shared/types'
import { categoryLabel } from '@shared/dispatch'
import type { TaskFile } from '@shared/api'
import { api, errText, focusTask, op, openDeploy, setState, toast, liveTasks, useStore } from '../store'
import { TerminalView } from '../components/Terminal'
import { ModellerView, useModellerLive } from '../components/ModellerView'
import { ModellerCardView, ModellerSteps } from '../components/ModellerSteps'
import { modellerCanvas, type UnitFilePreview } from '@shared/modeller'
import { Markdown } from '../components/Markdown'
import { Chip, Confirm, DislikeMarker, Empty, Modal, Field, NeedsYou, Tabs, ViewHeader, useNow } from '../components/ui'
import { GenioCore } from '../components/GenioCore'
import { Popover } from '../components/Layer'
import { RATEABLE, VerdictButtons, VerdictPick, rateThenMerge } from '../components/Dispatch'
import { unitKindLabel } from '../lib/vocab'
import { UnitKindIcon, unitKindChip } from '../components/UnitKind'
import { ago, clock, cx, shortPath } from '../lib/format'
import { assetBytes } from '../lib/inventory'
import { playSfx } from '../lib/sfx'
import { squadAttention, squadBadge, squadState, squadTone, unitClock } from '@shared/squad-display'
import { UNIT_ACTION_HINT, canRespawn, hasOpenPr } from '@shared/unit-actions'
import {
  canRate, deliveryLabel, mergeTimeline, needsInput, parsePings, parseStatusLines, parseUnitChanges, primaryAction, prMergeBlock,
  reportedTests, unitBadge, unitPlay, type TimelineRow, type UnitChanges
} from '@shared/unit-page'
import { pendingDecision } from '@shared/decisions'
import { mergeApprovalLabel } from '@shared/merge-approval'
import { supportsUnitySlots } from '@shared/play'
import { effectiveEngine } from '@shared/engine'
import { listFact, useScreenContext } from '../lib/screen-context'
import { requestPlaySource } from '../lib/play-nav'
import { planStepOfTask } from '@shared/work-plan'
import { PlanChip } from '../components/PlanChip'

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
  // Login sessions; the terminal pane shows its own terminals.
  const sessions = Object.values(terminals).filter((t) => t.kind !== 'worker' && t.kind !== 'pane')
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
    <article className={cx('unit-card panel', `tone-${tone}`, recon && 'recon', t.modeller && 'modeller', !t.modeller && t.generator && 'generator', attention && 'attention')}>
      <header className="unit-head" onClick={() => focusTask(t.id)}>
        <div className="unit-kind">
          <UnitKindIcon t={t} size={14} />
          <span>{unitKindLabel(t)}</span>
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
        {t.modeller ? (
          <ModellerCardSlot t={t} term={term} />
        ) : term && term.alive ? (
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

/** A Modeller's card shows its model, not its terminal: the latest step's render and caption, an empty frame before the first. */
function ModellerCardSlot({ t, term }: { t: Task; term?: TerminalInfo }) {
  const live = useModellerLive(t.id, !!term?.alive, 4000)
  if (live || modellerCanvas(t)) return <ModellerCardView live={live} />
  return term?.alive ? <TerminalView id={term.id} fontSize={11} passive interactive={false} /> : <NoSignal t={t} />
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

type TabId = 'steps' | 'terminal' | 'changes' | 'timeline' | 'brief' | 'report' | 'checks'
/**
 * The main area is the terminal, or a Modeller's live model (its terminal then becomes a side tab).
 * Under 900 px one pane shows at a time: the main area or a side tab.
 */
type PaneId = 'main' | TabId

const sleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms))
const since = (iso: string, now: number): string => {
  const a = ago(iso, now)
  return a === 'now' ? 'just now' : `${a} ago`
}

/** A task file, reloaded when `deps` change and every `pollMs` while given. */
function useTaskFile(id: string, which: TaskFile, deps: unknown[], pollMs?: number, enabled = true): { text: string | null; err: string } {
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    setText(null)
    setErr('')
  }, [id, which])
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const load = (): void => {
      void api()
        .readTaskFile(id, which)
        .then((s) => { if (alive) { setErr(''); setText(s ?? '') } })
        .catch((e) => { if (alive) { setErr(errText(e)); setText('') } })
    }
    load()
    const iv = pollMs ? window.setInterval(load, pollMs) : undefined
    return () => {
      alive = false
      if (iv) window.clearInterval(iv)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, which, pollMs, enabled, ...deps])
  return { text, err }
}

/** The unit header's narrow layout (app.css, max-width 720px): secondary buttons move under More. */
const NARROW_HEADER = '(max-width: 720px)'
function useNarrowHeader(): boolean {
  const [narrow, setNarrow] = useState(() => !!window.matchMedia?.(NARROW_HEADER).matches)
  useEffect(() => {
    const m = window.matchMedia?.(NARROW_HEADER)
    if (!m) return
    const on = (): void => setNarrow(m.matches)
    m.addEventListener?.('change', on)
    return () => m.removeEventListener?.('change', on)
  }, [])
  return narrow
}

/** Open state and anchor for a header popover; the Popover closes it on Escape or a click elsewhere. */
function usePopover() {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  return [open, setOpen, wrap] as const
}

function UnitDetail({ id }: { id: string }) {
  const t = useStore((s) => s.snap.tasks.find((x) => x.id === id))
  const term = useStore((s) => (t?.terminalId ? s.terminals[t.terminalId] : undefined))
  const project = useStore((s) => s.snap.projects.find((p) => p.name === t?.project))
  const settings = useStore((s) => s.settings)
  const now = useNow(1000)
  const events = useStore((s) => s.statusByTask[id]?.length ?? 0)
  const question = useStore((s) => s.snap.decisions.find((d) => d.taskId === id && pendingDecision(d, now)))
  const plans = useStore((s) => s.snap.plans)
  const planStep = t && plans?.length ? planStepOfTask(plans, t) : undefined
  const reconFinished = t?.kind === 'scout' && (t.state === 'done' || !!t.reportPath)
  const [tab, setTab] = useState<TabId>(() => (reconFinished ? 'report' : t?.kind === 'scout' ? 'timeline' : 'changes'))
  const [pane, setPane] = useState<'main' | 'side'>(() => (reconFinished ? 'side' : 'main'))
  const [confirm, setConfirm] = useState<null | 'despawn' | 'archive' | 'force' | 'merge' | 'recall'>(null)
  const [refusal, setRefusal] = useState('')
  const [upgrade, setUpgrade] = useState(false)
  const [verdict, setVerdict] = useState<Verdict | undefined>()
  const narrowHeader = useNarrowHeader()
  const live = !!term?.alive
  const status = useTaskFile(id, 'status', [events, t?.state], undefined, !!t)
  const changesFile = useTaskFile(id, 'diffstat', [events, t?.state], live ? 8000 : undefined, !!t && t.kind === 'ship')
  const statusRows = useMemo(() => parseStatusLines(status.text ?? ''), [status.text])
  const changes = useMemo(() => parseUnitChanges(changesFile.text ?? ''), [changesFile.text])
  // A Generator has no live view: its terminal stays the main area.
  const modeller = useModellerLive(id, live && t?.kind === 'ship' && !t.generator)
  // A Modeller's page is canvas first from its start: the live model (an empty scene until the first
  // step) is the main area and its steps the first side tab.
  const canvas = t?.kind === 'ship' && (!!modeller || modellerCanvas(t))
  useEffect(() => { if (canvas) { setTab('steps'); setPane('main') } }, [canvas])
  const head = modeller?.steps.at(-1)
  useScreenContext('squad', { facts: t ? [
    { label: 'Unit', value: `${t.title} [${t.id}]` },
    { label: 'State', value: `${unitBadge(t, term).label} (${t.state}) · ${unitKindLabel(t)} · ${t.branch}` },
    { label: 'Tab', value: canvas && pane === 'main' ? 'model (live 3D view)' : tab },
    modeller ? { label: 'Model', value: `${modeller.model} · ${head ? `step ${head.n} of ${modeller.steps.length}: ${head.caption}` : 'no steps yet'} · branch ${modeller.branch}${modeller.running ? ` · now running step ${modeller.running.n}: ${modeller.running.caption}` : ''}` }
      : canvas && { label: 'Model', value: 'no steps yet' },
    statusRows.length > 0 && { label: 'Last status', value: `${statusRows.at(-1)!.verb}: ${statusRows.at(-1)!.text}` }
  ] : [{ label: 'Unit', value: `${id} (gone)` }] })

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

  const badge = unitBadge(t, term)
  const attention = squadAttention(t, term, !!question)
  const recon = t.kind === 'scout'
  const cleaned = t.state === 'cleaned'
  const primary = primaryAction(t, term, !!question)
  const hardcore = !!t.validation || t.mode === 'no-mistakes'
  const lagging = needsInput(t, term, now, settings?.staleSeconds)
  const termLabel = lagging ? 'Terminal ●' : 'Terminal'
  const tabs = ([
    canvas && { id: 'steps', label: 'Steps' },
    canvas && term && { id: 'terminal', label: termLabel },
    !recon && { id: 'changes', label: 'Changes', badge: changes.files.length },
    { id: 'timeline', label: 'Timeline' },
    { id: 'brief', label: 'Brief' },
    (recon || !!t.reportPath) && { id: 'report', label: 'Report' },
    !recon && hardcore && { id: 'checks', label: 'Checks' }
  ] as ({ id: TabId; label: string; badge?: number } | false)[]).filter((x): x is { id: TabId; label: string; badge?: number } => !!x)
  const current: TabId = tabs.some((x) => x.id === tab) ? tab : tabs[0].id
  const main = canvas ? { id: 'main' as PaneId, label: 'Model' } : term ? { id: 'main' as PaneId, label: termLabel } : undefined
  const shown: PaneId = main && pane === 'main' ? 'main' : current
  const showPane = (p: PaneId): void => {
    setPane(p === 'main' ? 'main' : 'side')
    if (p !== 'main') setTab(p)
  }

  const latest = statusRows.at(-1)
  const stopped = primary === 'respawn'
  const line = stopped
    ? `Stopped: ${stopReason(t)}`
    : latest ? `${latest.verb}: ${latest.text}${latest.at ? ` · ${since(new Date(latest.at).toISOString(), now)}` : ''}` : t.stateReason ?? ''

  // Play this unit: beside the primary action (never instead of it); under More on narrow widths.
  const play = unitPlay(t, !!project && supportsUnitySlots(effectiveEngine(project).engine), changes.removed)
  const playThis = (): void => { if (project) requestPlaySource(t.project, project.path, `unit:${t.id}`) }
  const more = ([
    play && { id: 'play', label: 'Play', hint: play.hint, narrow: true, disabled: !play.enabled, run: playThis },
    live && squadState(t, term) === 'WORKING' && { id: 'interrupt', label: 'Interrupt', hint: UNIT_ACTION_HINT.interrupt,
      run: () => void op('Interrupt', () => api().controlTask(t.id, 'interrupt')) },
    canRespawn(t) && { id: 'respawn', label: 'Respawn', hint: UNIT_ACTION_HINT.respawn, run: () => void op('Respawn', () => api().controlTask(t.id, 'relaunch')) },
    live && { id: 'recall', label: 'Recall', hint: UNIT_ACTION_HINT.recall, run: () => setConfirm('recall') },
    !cleaned && { id: 'folder', label: 'Open folder', hint: UNIT_ACTION_HINT.folder, run: () => void api().openPath(t.worktree) },

    !cleaned && { id: 'despawn', label: 'Despawn…', hint: UNIT_ACTION_HINT.despawn, tone: 'danger', run: () => setConfirm('despawn') }
  ] as (MoreItem | false)[]).filter((x): x is MoreItem => !!x)

  const despawn = async (force: boolean): Promise<void> => {
    try {
      const r = await api().cleanupTask(t.id, force)
      if (r.ok) {
        toast('success', recon ? 'Archived' : 'Despawned', r.message)
        setState({ focus: null })
      } else {
        setRefusal(r.message)
        setConfirm('force')
      }
    } catch (e) {
      toast('error', 'Despawn failed', errText(e))
    }
  }

  const prNo = t.pr?.number ? ` #${t.pr.number}` : ''
  const mergeOff = primary === 'merge-pr' ? prMergeBlock(t.pr!) : project?.gitRepo === false ? 'Merge needs a git repo.' : ''

  return (
    <div className="view detail unit-detail">
      <header className="detail-head unit-head">
        <div className="uh-row">
          <button className="btn ghost sm" onClick={() => setState({ focus: null })}>
            <ArrowLeft size={14} /> Squad
          </button>
          <span className={cx('chip', unitKindChip(t))}>
            <UnitKindIcon t={t} size={11} /> {unitKindLabel(t)}
          </span>
          <span className="uh-state">
            <Chip tone={badge.tone} pulse={badge.label === 'WORKING'}>{badge.label}</Chip>
          </span>
          {planStep && <PlanChip plan={planStep.plan} step={planStep.step} />}
          {attention && <NeedsYou />}
          {t.dislikePause && <DislikeMarker />}
          <span className="mute detail-clock">{unitClock(t, term, now)}</span>
          {t.state === 'ready' && t.readyAt && <span className="mute uh-since">· ready {since(t.readyAt, now)}</span>}
          <UnitInfo t={t} />
        </div>
        <h1 className="title unit-name" title={t.title}>
          {t.title}
        </h1>
        {t.mergeApproval && (
          <div className="uh-approval mute" title={mergeApprovalLabel(t.mergeApproval, 2000)}>
            <GitMerge size={11} /> {mergeApprovalLabel(t.mergeApproval)}
          </div>
        )}
        <div className="uh-actions">
          <div className={cx('uh-line', stopped ? 'alert-text' : 'dim')} title={line}>{line}</div>
          {canRate(t, term) && <VerdictButtons t={t} label={false} />}
          {primary === 'merge-local' && (
            <button className="btn sm solid volt uh-primary" disabled={!!mergeOff} title={mergeOff || `Fast-forwards ${t.branch} into ${t.baseBranch} in your local copy`} onClick={() => setConfirm('merge')}>
              <GitMerge size={13} /> Merge into {t.baseBranch}
            </button>
          )}
          {primary === 'merge-pr' && (
            <>
              <button className="btn sm solid volt uh-primary" disabled={!!mergeOff} title={mergeOff || `Squash-merges PR${prNo} into ${t.baseBranch}`} onClick={() => setConfirm('merge')}>
                <GitMerge size={13} /> Merge PR{prNo}
              </button>
              <button className="btn sm ghost" title={t.pr!.url} onClick={() => void api().openExternal(t.pr!.url)}>
                <ExternalLink size={13} /> Open PR
              </button>
            </>
          )}
          {primary === 'respawn' && (
            <button className="btn sm solid uh-primary" disabled={!canRespawn(t)} title={UNIT_ACTION_HINT.respawn} onClick={() => void op('Respawn', () => api().controlTask(t.id, 'relaunch'))}>
              <RotateCcw size={13} /> Respawn
            </button>
          )}
          {primary === 'recon-done' && (
            <>
              <button className="btn sm solid violet uh-primary" title={UNIT_ACTION_HINT.build} onClick={() => setUpgrade(true)}>
                <ArrowUpFromLine size={13} /> Build from this report
              </button>
              <button className="btn sm ghost" title={UNIT_ACTION_HINT.archive} onClick={() => setConfirm('archive')}>
                <Archive size={13} /> Archive
              </button>
            </>
          )}
          {play && !narrowHeader && (
            <button className="btn sm ghost uh-play" disabled={!play.enabled} title={play.hint} onClick={playThis}>
              <PlayIcon size={13} /> Play
            </button>
          )}
          <MoreMenu items={more} />
        </div>
        {primary === 'question' && <UnitQuestion t={t} d={question} fallback={latest?.text ?? t.stateReason ?? ''} />}
      </header>

      <div className="detail-switch">
        <Tabs<PaneId> value={shown} onChange={showPane} tabs={[...(main ? [main] : []), ...tabs]} />
      </div>
      <div className={cx('detail-body', !main && 'no-term', shown === 'main' ? 'pane-terminal' : 'pane-side')}>
        {canvas ? (
          <div className="detail-term detail-canvas panel">
            <ModellerView live={modeller} />
          </div>
        ) : term && (
          <div className="detail-term panel">
            <UnitTerminal id={term.id} alive={term.alive} lagging={lagging} />
          </div>
        )}
        <aside className="detail-side panel">
          <div className="detail-side-tabs">
            <Tabs<TabId> value={current} onChange={setTab} tabs={tabs} />
          </div>
          <div className={cx('detail-tab', current === 'terminal' && 'detail-tab-term')}>
            {current === 'steps' && (modeller ? <ModellerSteps t={t} live={modeller} /> : <div className="mute">No steps yet.</div>)}
            {current === 'terminal' && term && <UnitTerminal id={term.id} alive={term.alive} lagging={lagging} fit />}
            {current === 'changes' && <ChangesTab t={t} changes={changes} loading={changesFile.text === null} err={changesFile.err} rows={statusRows} />}
            {current === 'timeline' && <TimelineTab t={t} rows={statusRows} loading={status.text === null} />}
            {current === 'brief' && <FileMarkdown t={t} which="brief" empty="No brief." />}
            {current === 'report' && <FileMarkdown t={t} which="report" empty="No report yet. The Recon writes it before declaring done." />}
            {current === 'checks' && <ChecksTab t={t} />}
          </div>
        </aside>
      </div>

      <PingBox t={t} live={live} steer={primary === 'steer'} />

      {(confirm === 'despawn' || confirm === 'archive') && (
        <Confirm
          title={confirm === 'archive' ? 'Archive this Recon?' : 'Despawn this unit?'}
          tone={confirm === 'archive' ? 'violet' : 'alert'}
          confirmLabel={confirm === 'archive' ? 'Archive' : 'Despawn'}
          body={
            confirm === 'archive' ? (
              <p>Genio removes the Recon's isolated copy and branch. Its report, timeline and record stay, and Build from this report stops being offered.</p>
            ) : (
              <>
                {hasOpenPr(t) && (
                  <p className="amber-text despawn-pr">
                    PR{prNo} is still open. After Despawn, Genio stops watching its checks and you can no longer merge it from here; the PR itself stays open.
                  </p>
                )}
                <p>
                  Genio deletes the isolated copy and its branch, and closes the unit's shells, only if nothing would be lost: no uncommitted changes, and the work is pushed, merged, or already in{' '}
                  <span className="mono">{t.baseBranch}</span>. Otherwise it refuses and tells you why.
                </p>
              </>
            )
          }
          onConfirm={() => despawn(false)}
          onClose={() => setConfirm((c) => (c === 'despawn' || c === 'archive' ? null : c))}
        />
      )}
      {confirm === 'force' && (
        <Confirm
          title={recon ? 'Archive refused' : 'Despawn refused'}
          tone="alert"
          typed="DISCARD"
          confirmLabel={recon ? 'Force archive' : 'Force despawn'}
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
          title={t.pr?.url ? `Merge PR${prNo}?` : `Merge into ${t.baseBranch}?`}
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

/**
 * The unit's own terminal: the main area of a Build, a side tab of a Modeller. The main area watches
 * the agent's PTY at its own size, scaled to fit, until clicked; the narrow side tab (`fit`) fits the
 * PTY to itself at once so it is legible without a click.
 */
function UnitTerminal({ id, alive, lagging, fit = false }: { id: string; alive: boolean; lagging: boolean; fit?: boolean }) {
  return (
    <>
      {lagging && (
        <span className="needs-input" title="No output for a while: the agent may be waiting at a prompt. Click the terminal to type, or ping it below.">
          <i className="dot pulse" /> needs input
        </span>
      )}
      <TerminalView id={id} fontSize={13} passive={!fit} interactive={alive} />
    </>
  )
}

/** Why a unit stopped, in words, for the Respawn row. */
function stopReason(t: Task): string {
  if (t.stateReason && t.stateReason !== 'respawned' && t.stateReason !== 'deployed') return t.stateReason
  if (t.state === 'detached') return 'Genio restarted while it ran; its copy is intact.'
  if (t.state === 'exited') return 'the agent exited without a final status.'
  return 'the agent is not running.'
}

interface MoreItem {
  id: string
  label: string
  /** One-line consequence, shown under the label. */
  hint: string
  tone?: 'warn' | 'danger'
  /** Listed only on narrow widths, where its own button is hidden. */
  narrow?: boolean
  disabled?: boolean
  run: () => void
}

/** The rare controls, each with what it does. */
function MoreMenu({ items: all }: { items: MoreItem[] }) {
  const [open, setOpen, wrap] = usePopover()
  const narrow = useNarrowHeader()
  const items = all.filter((it) => narrow || !it.narrow)
  if (!items.length) return null
  return (
    <div className="unit-more" ref={wrap}>
      <button className="btn sm ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal size={14} /> More <ChevronDown size={12} />
      </button>
      {open && (
        <Popover anchor={wrap} placement="bottom-end" className="unit-menu" role="menu" aria-label="More unit actions" onClose={() => setOpen(false)}>
          {items.map((it) => (
            <button key={it.id} role="menuitem" className={cx('unit-menu-item', it.tone)} disabled={it.disabled} onClick={() => { setOpen(() => false); it.run() }}>
              <span className="umi-label">{it.label}</span>
              <span className="umi-hint">{it.hint}</span>
            </button>
          ))}
        </Popover>
      )}
    </div>
  )
}

/** ⓘ details: the unit's facts, out of the header. */
function UnitInfo({ t }: { t: Task }) {
  const [open, setOpen, wrap] = usePopover()
  const rows = ([
    ['Project', t.project],
    ['Branch', <><span className="mono">{t.branch}</span> → <span className="mono">{t.baseBranch}</span></>],
    ['Model', `${t.harness}${t.model ? ` / ${t.model}` : ''}`],
    ['Effort', t.effort ?? 'default'],
    t.category && ['Category', categoryLabel(t.category)],
    ['Delivery', deliveryLabel(t.kind === 'scout' ? undefined : t.mode, t.baseBranch)],
    t.kind === 'ship' && ['Auto-loot', t.yolo ? 'On: Genio may merge green work itself' : 'Off: merging waits for you'],
    t.landedCommit && ['Commit', <span className="mono selectable">{t.landedCommit.slice(0, 12)}</span>],
    t.relaunches > 0 && ['Respawned', `${t.relaunches}×`]
  ] as ([string, ReactNode] | false | undefined | '')[]).filter((r): r is [string, ReactNode] => !!r)
  return (
    <div className="unit-info" ref={wrap}>
      <button className="link-btn mute uh-info" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Info size={12} /> details
      </button>
      {open && (
        <Popover anchor={wrap} className="unit-info-pop" role="dialog" aria-label="Unit details" onClose={() => setOpen(false)}>
          <dl>
            {rows.map(([k, v]) => (
              <div key={k} className="ui-row">
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {!!t.loadout?.length && (
            <div className="ui-loadout">
              <div className="label">Loadout{t.explored ? ' · exploring' : ''}</div>
              <ul>{t.loadout.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </div>
          )}
        </Popover>
      )}
    </div>
  )
}

/** The open question, answered right here (blocked or needs-decision units). */
function UnitQuestion({ t, d, fallback }: { t: Task; d?: Decision; fallback: string }) {
  const [busy, setBusy] = useState(false)
  const [own, setOwn] = useState('')
  if (!d) {
    return (
      <div className="unit-question">
        <div className="label amber-text">{t.state === 'blocked' ? 'Blocked' : 'Waiting for you'}</div>
        <div className="uq-q">{fallback || 'The unit is waiting for an answer.'}</div>
        <div className="mute uq-hint">Answer in the ping box below.</div>
      </div>
    )
  }
  const answer = async (text: string): Promise<void> => {
    if (!text.trim() || busy) return
    setBusy(true)
    try {
      const r = await op('Your move', () => api().answerDecision(d.id, text.trim()))
      if (r?.ok) setOwn('')
    } finally {
      setBusy(false)
    }
  }
  const rec = (o: string): boolean => !!d.recommendation && o.trim().toLowerCase() === d.recommendation.trim().toLowerCase()
  return (
    <div className="unit-question">
      <div className="label amber-text">Open question</div>
      <div className="uq-q">{d.question}</div>
      {d.context && (
        <details className="choice-context">
          <summary>Details</summary>
          <Markdown text={d.context} className="md-compact" />
        </details>
      )}
      <div className="uq-answers">
        {d.options.map((o) => (
          <button key={o} className={cx('btn sm', rec(o) ? 'solid amber' : 'ghost')} disabled={busy} title={rec(o) ? 'Recommended' : undefined} onClick={() => void answer(o)}>
            {o}
          </button>
        ))}
        <input className="input uq-own" value={own} disabled={busy} placeholder={d.options.length ? 'Or your own answer' : 'Your answer'} aria-label="Your answer"
          onChange={(e) => setOwn(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void answer(own) }} />
        <button className="btn sm" disabled={busy || !own.trim()} onClick={() => void answer(own)}>Answer</button>
      </div>
    </div>
  )
}

/** Full width under the content: pings land in the unit's inbox and ring it. */
function PingBox({ t, live, steer }: { t: Task; live: boolean; steer: boolean }) {
  const settings = useStore((s) => s.settings)
  const [text, setText] = useState('')
  const [interrupt, setInterrupt] = useState(false)
  const [busy, setBusy] = useState(false)
  const cleaned = t.state === 'cleaned'
  const send = async (): Promise<void> => {
    const msg = text.trim()
    if (!msg || busy) return
    setBusy(true)
    try {
      if (interrupt && live) {
        await op('Interrupt', () => api().controlTask(t.id, 'interrupt'))
        await sleep(400)
      }
      const r = await op('Ping', () => api().sendToTask(t.id, msg))
      if (r?.ok) {
        setText('')
        setInterrupt(false)
        playSfx('send', settings)
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={cx('ping-box unit-ping', steer && 'steer')}>
      <textarea
        className="textarea"
        rows={2}
        value={text}
        disabled={cleaned}
        aria-label="Ping this unit"
        placeholder={cleaned ? 'Despawned: nothing to ping.' : steer ? 'Steer this unit: lands in its inbox and rings it (Ctrl+Enter)' : 'Ping this unit: lands in its inbox (Ctrl+Enter)'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send()
        }}
      />
      <div className="ping-side">
        {live && (
          <label className="ping-interrupt" title={`Interrupt first. ${UNIT_ACTION_HINT.interrupt}`}>
            <input type="checkbox" checked={interrupt} onChange={(e) => setInterrupt(e.target.checked)} /> interrupt and send
          </label>
        )}
        <button className="btn solid icon" disabled={!text.trim() || busy || cleaned} onClick={() => void send()} title={interrupt && live ? 'Interrupt, then ping (Ctrl+Enter)' : 'Ping (Ctrl+Enter)'}>
          <Send size={14} />
        </button>
      </div>
    </div>
  )
}

function UpgradeModal({ t, onClose }: { t: Task; onClose: () => void }) {
  const [intent, setIntent] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      kicker="Build from this report"
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
            <ArrowUpFromLine size={14} /> Build it
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

function FileMarkdown({ t, which, empty }: { t: Task; which: 'brief' | 'report'; empty: string }) {
  const { text, err } = useTaskFile(t.id, which, [t.state])
  if (text === null) return <div className="bar indeterminate"><i /></div>
  if (err) return <div className="alert-text mono" style={{ fontSize: 12 }}>{err}</div>
  const body = text.trim()
  return body && body !== '(no report yet)' && body !== '(no brief)' ? <Markdown text={text} className="md-compact" /> : <div className="mute">{empty}</div>
}

/** What the branch changes, and what is known about its tests. */
function ChangesTab({ t, changes, loading, err, rows }: { t: Task; changes: UnitChanges; loading: boolean; err: string; rows: TimelineRow[] }) {
  const [full, setFull] = useState(false)
  if (loading) return <div className="bar indeterminate"><i /></div>
  if (err) return <div className="alert-text mono" style={{ fontSize: 12 }}>{err}</div>
  const tests = testsLine(t, rows)
  const most = Math.max(1, ...changes.files.map((f) => f.changes))
  return (
    <div className="changes">
      {changes.removed ? (
        <div className="mute">The copy was removed on despawn.{t.landedCommit ? ` Landed as ${t.landedCommit.slice(0, 12)}.` : ''}</div>
      ) : (
        <>
          <div className="ch-sum mono">
            <span className="volt-text">+{changes.insertions}</span> <span className="alert-text">−{changes.deletions}</span>
            {' · '}{changes.files.length} {changes.files.length === 1 ? 'file' : 'files'} · {changes.commits.length} {changes.commits.length === 1 ? 'commit' : 'commits'}
            {changes.uncommitted.length > 0 && <span className="amber-text"> · {changes.uncommitted.length} uncommitted</span>}
          </div>
          {changes.files.length === 0 && changes.uncommitted.length === 0 ? (
            <div className="mute">No changes on this branch yet.</div>
          ) : (
            <ul className="ch-files">
              {changes.files.map((f) => (
                <li key={f.path} title={f.path} className={cx(f.binary && PREVIEWABLE.test(f.path) && 'ch-has-preview')}>
                  <div className="ch-row">
                    <span className="mono ch-path">{f.path}</span>
                    <span className="mono mute ch-n">{f.binary ? 'bin' : f.changes}</span>
                    <i className="ch-bar" style={{ width: `${Math.round((f.changes / most) * 100)}%` }} />
                  </div>
                  {f.binary && PREVIEWABLE.test(f.path) && <BinaryPreview t={t} file={f.path} rev={changes.commits[0] ?? ''} />}
                </li>
              ))}
              {changes.uncommitted.map((u) => (
                <li key={u} className="amber-text"><span className="mono ch-path">{u}</span></li>
              ))}
            </ul>
          )}
          {changes.commits.length > 0 && (
            <details className="ch-commits">
              <summary className="label">Commits</summary>
              <pre className="file-pre selectable">{changes.commits.join('\n')}</pre>
            </details>
          )}
        </>
      )}
      <div className="ch-tests">
        <div className="label">Tests</div>
        <div className={cx('ch-tests-line', tests.tone)}>{tests.text}</div>
        {tests.note && <div className="mute ch-note">{tests.note}</div>}
      </div>
      {!changes.removed && (changes.files.length > 0 || changes.uncommitted.length > 0) && (
        <>
          <button className="btn sm ghost" onClick={() => setFull((f) => !f)}>{full ? 'Hide the diff' : 'Show the full diff'}</button>
          {full && <FullDiff t={t} />}
        </>
      )}
    </div>
  )
}

/** Binary files the Changes tab can show as pictures: images, and models (drawn by Inventory, or the Modeller's render). */
const PREVIEWABLE = /^(?!.*=>)[^]*\.(png|jpe?g|webp|gif|bmp|avif|glb|gltf|fbx|obj|stl|ply|dae|usda?|3ds|blend)$/i

/** Before and after thumbnails of a binary file, with its size change (and a model's triangles and parts). */
function BinaryPreview({ t, file, rev }: { t: Task; file: string; rev: string }) {
  const [p, setP] = useState<UnitFilePreview | null>(null)
  useEffect(() => {
    let alive = true
    void api().unitFilePreview(t.id, file).then((r) => { if (alive) setP(r) }, () => { if (alive) setP({ kind: 'other' }) })
    return () => { alive = false }
  }, [t.id, file, rev])
  if (!p || p.kind === 'other') return null
  const side = (label: string, url: string | undefined, size: number | undefined, missing: string): ReactNode => (
    <figure className="ch-thumb">
      {url ? <img src={url} alt={`${file}, ${label}`} loading="lazy" onError={(e) => { e.currentTarget.style.visibility = 'hidden' }} /> : <span className="mute">{size === undefined ? missing : 'no preview'}</span>}
      <figcaption className="mute">{label}{size !== undefined ? ` · ${assetBytes(size)}` : ''}</figcaption>
    </figure>
  )
  return (
    <div className="ch-preview">
      {side('before', p.before, p.beforeBytes, 'new file')}
      <span className="ch-arrow mute">→</span>
      {side('after', p.after, p.afterBytes, 'removed')}
      {p.triangles !== undefined && <div className="mute ch-preview-note">{p.triangles.toLocaleString()} triangles · {p.parts} parts (Modeller's latest step)</div>}
    </div>
  )
}

function testsLine(t: Task, rows: TimelineRow[]): { text: string; tone: string; note?: string } {
  const v = t.validation
  if (v) {
    const failed = v.steps.find((s) => s.state === 'failed')
    if (v.state === 'running') return { text: `◐ The Gauntlet is running (round ${v.round})`, tone: 'neon-text' }
    if (v.state === 'passed') return { text: `✓ The Gauntlet passed (round ${v.round})`, tone: 'volt-text' }
    return { text: `✕ The Gauntlet ${v.state === 'findings' ? 'has findings' : v.state}${failed ? `: ${failed.name}` : ''}`, tone: 'alert-text', note: 'See Checks.' }
  }
  if (t.pr?.url && t.pr.checks) {
    const c = t.pr.checks
    return { text: c === 'passing' ? '✓ PR checks are green' : c === 'failing' ? '✕ PR checks are failing' : c === 'pending' ? '◐ PR checks are running' : 'This PR has no checks', tone: c === 'passing' ? 'volt-text' : c === 'failing' ? 'alert-text' : '' }
  }
  const said = reportedTests(rows)
  const note = t.mode === 'local-only' ? 'Genio runs no tests before a local merge; this is the unit\'s own word.' : undefined
  return said ? { text: `The unit reported: “${said}”`, tone: '', note } : { text: 'No test result reported yet.', tone: 'mute', note }
}

function FullDiff({ t }: { t: Task }) {
  const { text, err } = useTaskFile(t.id, 'diff', [t.state])
  if (text === null) return <div className="bar indeterminate"><i /></div>
  if (err) return <div className="alert-text mono" style={{ fontSize: 12 }}>{err}</div>
  return text.trim() ? <Diff text={text} /> : <div className="mute">No changes on this branch yet.</div>
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
  'player-held': 'amber',
  ping: 'violet'
}

/** Status lines and pings in one list, newest first. */
function TimelineTab({ t, rows, loading }: { t: Task; rows: TimelineRow[]; loading: boolean }) {
  const inbox = useTaskFile(t.id, 'inbox', [t.inbox.seq, t.inbox.acked], t.state === 'cleaned' ? undefined : 8000)
  const list = useMemo(() => mergeTimeline(rows, parsePings(inbox.text ?? '')), [rows, inbox.text])
  if (loading) return <div className="bar indeterminate"><i /></div>
  if (!list.length) return <div className="mute">No status reported and no pings sent yet.</div>
  return (
    <div className="timeline">
      {list.map((r, i) => (
        <div key={i} className={cx('tl-row', r.verb === 'ping' && 'tl-ping')}>
          <span className={cx('tl-verb', VERB_TONE[r.verb] ?? 'mute')}>{r.verb === 'ping' ? 'you' : r.verb}</span>
          <div className="tl-text selectable">
            {r.tags && <span className="mono mute">{r.tags} </span>}
            {r.text}
            {r.unread && <span className="mono mute"> · unread</span>}
          </div>
          <span className="mono mute tl-time">{r.at ? clock(new Date(r.at).toISOString()) : ''}</span>
        </div>
      ))}
    </div>
  )
}

function ChecksTab({ t }: { t: Task }) {
  const { text } = useTaskFile(t.id, 'validation', [t.state, t.validation?.state], t.validation?.state === 'running' ? 8000 : undefined)
  if (text === null) return <div className="bar indeterminate"><i /></div>
  return <Gauntlet t={t} log={text} />
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
