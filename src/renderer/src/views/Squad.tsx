import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft, ChevronDown, ExternalLink, GitMerge, Info, MoreHorizontal, Play as PlayIcon, RotateCcw, Rocket, Send,
  SquareTerminal, ArrowUpFromLine, X
} from 'lucide-react'
import type { Decision, Task, TerminalInfo, ValidationStep } from '@shared/types'
import type { TaskFile } from '@shared/api'
import { api, errText, focusTask, op, openDeploy, setState, toast, liveTasks, useStore } from '../store'
import { TerminalView } from '../components/Terminal'
import { ModellerView, useModellerLive } from '../components/ModellerView'
import { ModellerCardView, ModellerSteps } from '../components/ModellerSteps'
import { modellerCanvas, type ModellerActivity, type UnitFilePreview } from '@shared/modeller'
import { Markdown } from '../components/Markdown'
import { Chip, Confirm, DislikeMarker, Empty, Modal, Field, NeedsYou, Tabs, ViewHeader, useNow } from '../components/ui'
import { Popover } from '../components/Layer'
import { VerdictButtons } from '../components/Dispatch'
import { unitKindLabel } from '../lib/vocab'
import { UnitKindIcon, unitKindChip } from '../components/UnitKind'
import { clock, cx } from '../lib/format'
import { playSfx } from '../lib/sfx'
import { pollWhileVisible } from '../lib/visible-poll'
import { squadAttention, squadBadge, squadState, squadTone, unitClock } from '@shared/squad-display'
import { canRespawn, despawnConfirm } from '@shared/unit-actions'
import {
  canRate, mergeTimeline, needsInput, parsePings, parseStatusLines, parseUnitChanges, primaryAction, prMergeBlock,
  reportedTests, statusWorthShowing, timelineLabel, timelineRows, unitBadge, unitPlay, type TimelineRow, type UnitChanges
} from '@shared/unit-page'
import { pendingDecision } from '@shared/decisions'
import { supportsUnitySlots } from '@shared/play'
import { effectiveEngine } from '@shared/engine'
import { listFact, useScreenContext } from '../lib/screen-context'
import { requestPlaySource } from '../lib/play-nav'
import { BriefTab } from '../components/BriefTab'

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
        <Empty title="No units deployed." />
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
  const reason = statusWorthShowing(t, attention) ? t.stateReason ?? '' : ''
  return (
    <article className={cx('unit-card panel', `tone-${tone}`, recon && 'recon', t.modeller && 'modeller', !t.modeller && t.generator && 'generator', attention && 'attention')}>
      <header className="unit-head" onClick={() => focusTask(t.id)}>
        <div className="unit-kind">
          <UnitKindIcon t={t} size={14} />
          <span>{unitKindLabel(t)}</span>
        </div>
        <div className="unit-title-wrap">
          <div className="unit-title">{t.title}</div>
        </div>
        <div className="unit-state">
          <Chip tone={badge.tone} pulse={badge.label === 'WORKING'}>
            {badge.label}
          </Chip>
          {attention && <NeedsYou />}
          {t.dislikePause && <DislikeMarker />}
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
        <span className="mute unit-reason" title={reason || undefined}>{reason}</span>
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
        {!s.alive && <div className="mute" style={{ fontSize: 11 }}>exited</div>}
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
          <h1 className="title" style={{ fontSize: 24 }}>
            {s.title}
          </h1>
        </div>
        <div className="view-actions">
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
    // A minimized window skips the poll (the diffstat runs git three times) and catches up when it is shown.
    const stop = pollMs ? pollWhileVisible(load, pollMs) : undefined
    return () => {
      alive = false
      stop?.()
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
  const reconFinished = t?.kind === 'scout' && (t.state === 'done' || !!t.reportPath)
  const [tab, setTab] = useState<TabId>(() => (reconFinished ? 'report' : t?.kind === 'scout' ? 'timeline' : 'changes'))
  const [pane, setPane] = useState<'main' | 'side'>(() => (reconFinished ? 'side' : 'main'))
  const [confirm, setConfirm] = useState<null | 'despawn' | 'merge' | 'recall'>(null)
  const [upgrade, setUpgrade] = useState(false)
  const narrowHeader = useNarrowHeader()
  const live = !!term?.alive
  const status = useTaskFile(id, 'status', [events, t?.state], undefined, !!t)
  const changesFile = useTaskFile(id, 'diffstat', [events, t?.state], live ? 8000 : undefined, !!t && t.kind === 'ship')
  const statusRows = useMemo(() => parseStatusLines(status.text ?? ''), [status.text])
  // What the player sees of the status log: no internal bookkeeping, no keys.
  const shownRows = useMemo(() => timelineRows(statusRows), [statusRows])
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
    modeller ? { label: 'Model', value: `${modeller.model} · ${head ? `step ${head.n} of ${modeller.steps.length}: ${head.caption}` : 'no steps yet'}${modeller.running ? ` · now running step ${modeller.running.n}: ${modeller.running.caption}` : ''}` }
      : canvas && { label: 'Model', value: 'no steps yet' },
    shownRows.length > 0 && { label: 'Last status', value: `${timelineLabel(shownRows.at(-1)!.verb)}: ${shownRows.at(-1)!.text}` }
  ] : [{ label: 'Unit', value: `${id} (gone)` }] })

  if (!t) {
    return (
      <div className="view">
        <button className="btn ghost" onClick={() => setState({ focus: null })}>
          <ArrowLeft size={14} /> Squad
        </button>
        <Empty title="Unit not found" />
      </div>
    )
  }

  const badge = unitBadge(t, term)
  const recon = t.kind === 'scout'
  const cleaned = t.state === 'cleaned'
  const primary = primaryAction(t, term, !!question)
  const hardcore = !!t.validation || t.mode === 'no-mistakes'
  const lagging = needsInput(t, term, now, settings?.staleSeconds)
  const tabs = ([
    canvas && { id: 'steps', label: 'Steps' },
    canvas && term && { id: 'terminal', label: 'Terminal' },
    !recon && { id: 'changes', label: 'Changes' },
    { id: 'timeline', label: 'Timeline' },
    { id: 'brief', label: 'Brief' },
    (recon || !!t.reportPath) && { id: 'report', label: 'Report' },
    !recon && hardcore && { id: 'checks', label: 'Checks' }
  ] as ({ id: TabId; label: string } | false)[]).filter((x): x is { id: TabId; label: string } => !!x)
  const current: TabId = tabs.some((x) => x.id === tab) ? tab : tabs[0].id
  const main = canvas ? { id: 'main' as PaneId, label: 'Model' } : term ? { id: 'main' as PaneId, label: 'Terminal' } : undefined
  const shown: PaneId = main && pane === 'main' ? 'main' : current
  const showPane = (p: PaneId): void => {
    setPane(p === 'main' ? 'main' : 'side')
    if (p !== 'main') setTab(p)
  }

  const latest = shownRows.at(-1)
  // What the live view says the unit is doing while no step runs: only while it works.
  const activity: ModellerActivity | null = canvas && live && badge.label === 'WORKING'
    ? { status: latest ? (latest.verb === 'working' ? latest.text : `${timelineLabel(latest.verb)}: ${latest.text}`) : '', since: Date.parse(t.createdAt) || now }
    : null
  // No status subtitle under the title on any unit kind: only a stopped unit says why, beside its Respawn.
  const stopped = primary === 'respawn' ? `Stopped: ${stopReason(t)}` : ''

  // Play this unit: beside the primary action (never instead of it); under More on narrow widths.
  const play = unitPlay(t, !!project && supportsUnitySlots(effectiveEngine(project).engine), changes.removed)
  const playThis = (): void => { if (project) requestPlaySource(t.project, project.path, `unit:${t.id}`) }
  const more = ([
    play && { id: 'play', label: 'Play', hint: play.enabled ? undefined : play.hint, narrow: true, disabled: !play.enabled, run: playThis },
    live && squadState(t, term) === 'WORKING' && { id: 'interrupt', label: 'Interrupt', run: () => void op('Interrupt', () => api().controlTask(t.id, 'interrupt')) },
    live && { id: 'recall', label: 'Recall', run: () => setConfirm('recall') },
    !cleaned && { id: 'folder', label: 'Open folder', run: () => void api().openPath(t.worktree) },
    !cleaned && { id: 'despawn', label: 'Despawn…', tone: 'danger', run: () => setConfirm('despawn') }
  ] as (MoreItem | false)[]).filter((x): x is MoreItem => !!x)

  // The player's click on the confirm is their word: unlanded work goes too, with no second dialog.
  const despawn = async (): Promise<void> => {
    try {
      const r = await api().cleanupTask(t.id, true)
      if (r.ok) {
        setState({ focus: null })
      } else {
        toast('error', 'Despawn failed', r.message)
      }
    } catch (e) {
      toast('error', 'Despawn failed', errText(e))
    }
  }
  const ask = despawnConfirm(t)

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
          {t.dislikePause && <DislikeMarker />}
          <span className="mute detail-clock">{unitClock(t, term, now)}</span>
          <UnitInfo t={t} />
        </div>
        <h1 className="title unit-name" title={t.title}>
          {t.title}
        </h1>
        <div className="uh-actions">
          {stopped && <div className="uh-line alert-text" title={stopped}>{stopped}</div>}
          {canRate(t, term) && <VerdictButtons t={t} />}
          {primary === 'merge-local' && (
            <button className="btn sm solid volt uh-primary" disabled={!!mergeOff} title={mergeOff || undefined} onClick={() => setConfirm('merge')}>
              <GitMerge size={13} /> Merge into {t.baseBranch}
            </button>
          )}
          {primary === 'merge-pr' && (
            <>
              <button className="btn sm solid volt uh-primary" disabled={!!mergeOff} title={mergeOff || undefined} onClick={() => setConfirm('merge')}>
                <GitMerge size={13} /> Merge PR{prNo}
              </button>
              <button className="btn sm ghost" onClick={() => void api().openExternal(t.pr!.url)}>
                <ExternalLink size={13} /> Open PR
              </button>
            </>
          )}
          {primary === 'respawn' && (
            <button className="btn sm solid uh-primary" disabled={!canRespawn(t)} onClick={() => void op('Respawn', () => api().controlTask(t.id, 'relaunch'))}>
              <RotateCcw size={13} /> Respawn
            </button>
          )}
          {primary === 'recon-done' && (
            <button className="btn sm solid violet uh-primary" onClick={() => setUpgrade(true)}>
              <ArrowUpFromLine size={13} /> Build from this report
            </button>
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
            <ModellerView live={modeller} activity={activity} />
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
            {current === 'steps' && (modeller ? <ModellerSteps live={modeller} /> : <div className="mute">No steps yet.</div>)}
            {current === 'terminal' && term && <UnitTerminal id={term.id} alive={term.alive} lagging={lagging} fit />}
            {current === 'changes' && <ChangesTab t={t} changes={changes} loading={changesFile.text === null} err={changesFile.err} rows={statusRows} />}
            {current === 'timeline' && <TimelineTab t={t} rows={statusRows} loading={status.text === null} />}
            {current === 'brief' && <BriefTab t={t} />}
            {current === 'report' && <FileMarkdown t={t} which="report" empty="No report yet." />}
            {current === 'checks' && <ChecksTab t={t} />}
          </div>
        </aside>
      </div>

      {!cleaned && <PingBox t={t} steer={primary === 'steer'} />}

      {confirm === 'despawn' && (
        <Confirm title={ask.line} tone="alert" confirmLabel={ask.button} onConfirm={despawn} onClose={() => setConfirm(null)} />
      )}
      {confirm === 'merge' && (
        <Confirm
          title={t.pr?.url ? `Merge PR${prNo}?` : `Merge into ${t.baseBranch}?`}
          tone="volt"
          confirmLabel="Merge"
          body={
            t.pr?.url ? (
              <>
                Squash-merge <a onClick={() => void api().openExternal(t.pr!.url)}>{t.pr.url}</a> into <span className="mono">{t.baseBranch}</span>.
              </>
            ) : (
              <>
                Fast-forward <span className="mono">{t.branch}</span> into <span className="mono">{t.baseBranch}</span>.
              </>
            )
          }
          onConfirm={async () => {
            const r = await op('Merge', () => api().mergeTask(t.id))
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
          body="Its copy and work stay. Reopening the project respawns it automatically."
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
        <span className="needs-input">
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
  /** Why a disabled item is off, shown under the label. */
  hint?: string
  tone?: 'warn' | 'danger'
  /** Listed only on narrow widths, where its own button is hidden. */
  narrow?: boolean
  disabled?: boolean
  run: () => void
}

/** The rare controls. */
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
              {it.hint && <span className="umi-hint">{it.hint}</span>}
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
    ['Branch', <><span className="mono">{t.branch}</span> → <span className="mono">{t.baseBranch}</span></>],
    ['Model', `${t.harness}${t.model ? ` / ${t.model}` : ''}`],
    ['Effort', t.effort ?? 'default'],
    t.landedCommit && ['Commit', <span className="mono selectable">{t.landedCommit.slice(0, 12)}</span>]
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
      {d.context && <Markdown text={d.context} className="md-compact choice-context" />}
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
function PingBox({ t, steer }: { t: Task; steer: boolean }) {
  const settings = useStore((s) => s.settings)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async (): Promise<void> => {
    const msg = text.trim()
    if (!msg || busy) return
    setBusy(true)
    try {
      const r = await op('Ping', () => api().sendToTask(t.id, msg))
      if (r?.ok) {
        setText('')
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
        aria-label="Ping this unit"
        placeholder="Ping this unit (Ctrl+Enter)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send()
        }}
      />
      <div className="ping-side">
        <button className="btn solid icon" disabled={!text.trim() || busy} onClick={() => void send()} title="Ping">
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
      <Field label="Your words (optional)">
        <textarea className="textarea" rows={4} value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="Implement the recommended fix…" />
      </Field>
    </Modal>
  )
}

function FileMarkdown({ t, which, empty }: { t: Task; which: 'report'; empty: string }) {
  const { text, err } = useTaskFile(t.id, which, [t.state])
  if (text === null) return <div className="bar indeterminate"><i /></div>
  if (err) return <div className="alert-text mono" style={{ fontSize: 12 }}>{err}</div>
  const body = text.trim()
  return body && body !== '(no report yet)' ? <Markdown text={text} className="md-compact" /> : <div className="mute">{empty}</div>
}

/** What the branch changes, and what is known about its tests. */
function ChangesTab({ t, changes, loading, err, rows }: { t: Task; changes: UnitChanges; loading: boolean; err: string; rows: TimelineRow[] }) {
  const [full, setFull] = useState(false)
  if (loading) return <div className="bar indeterminate"><i /></div>
  if (err) return <div className="alert-text mono" style={{ fontSize: 12 }}>{err}</div>
  const tests = testsLine(t, rows)
  return (
    <div className="changes">
      {changes.removed ? (
        <div className="mute">The copy was removed on despawn.</div>
      ) : (
        <>
          <div className="ch-sum mono">
            <span className="volt-text">+{changes.insertions}</span> <span className="alert-text">−{changes.deletions}</span>
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
                  </div>
                  {f.binary && PREVIEWABLE.test(f.path) && <BinaryPreview t={t} file={f.path} rev={changes.commits[0] ?? ''} />}
                </li>
              ))}
              {changes.uncommitted.map((u) => (
                <li key={u} className="amber-text"><span className="mono ch-path">{u}</span></li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="ch-tests">
        <div className="label">Tests</div>
        <div className={cx('ch-tests-line', tests.tone)}>{tests.text}</div>
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

/** Before and after thumbnails of a binary file. */
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
      <figcaption className="mute">{label}</figcaption>
    </figure>
  )
  return (
    <div className="ch-preview">
      {side('before', p.before, p.beforeBytes, 'new file')}
      <span className="ch-arrow mute">→</span>
      {side('after', p.after, p.afterBytes, 'removed')}
    </div>
  )
}

/** PR checks, else the unit's own words; a Hardcore unit's Gauntlet result is on its Checks tab. */
function testsLine(t: Task, rows: TimelineRow[]): { text: string; tone: string } {
  if (t.pr?.url && t.pr.checks) {
    const c = t.pr.checks
    return { text: c === 'passing' ? '✓ PR checks are green' : c === 'failing' ? '✕ PR checks are failing' : c === 'pending' ? '◐ PR checks are running' : 'This PR has no checks', tone: c === 'passing' ? 'volt-text' : c === 'failing' ? 'alert-text' : '' }
  }
  const said = reportedTests(rows)
  return said ? { text: `The unit reported: “${said}”`, tone: '' } : { text: 'No test result reported yet.', tone: 'mute' }
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

/** Status lines (as the player sees them) and pings in one list, newest first. The same for every unit kind. */
function TimelineTab({ t, rows, loading }: { t: Task; rows: TimelineRow[]; loading: boolean }) {
  const inbox = useTaskFile(t.id, 'inbox', [t.inbox.seq, t.inbox.acked], t.state === 'cleaned' ? undefined : 8000)
  const list = useMemo(() => mergeTimeline(timelineRows(rows), parsePings(inbox.text ?? '')), [rows, inbox.text])
  if (loading) return <div className="bar indeterminate"><i /></div>
  if (!list.length) return <div className="mute">No status reported and no pings sent yet.</div>
  return (
    <div className="timeline">
      {list.map((r, i) => (
        <div key={i} className={cx('tl-row', r.verb === 'ping' && 'tl-ping')}>
          <span className={cx('tl-verb', VERB_TONE[r.verb] ?? 'mute')}>{timelineLabel(r.verb)}</span>
          <div className="tl-text selectable">{r.text}</div>
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
        <div className="mute">Not run yet.</div>
      ) : (
        <>
          <div className="g-head">
            <span className={cx('chip', v.state === 'passed' ? 'volt' : v.state === 'running' ? 'neon' : v.state === 'findings' ? 'amber' : 'alert')}>{v.state}</span>
          </div>
          <div className="g-steps">
            {v.steps.map((s, i) => (
              <div key={i} className={cx('g-step', s.state)}>
                <span className={cx('g-light', toneOf(s.state))}>{icon(s.state)}</span>
                <span className="g-name">{s.name}</span>
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
