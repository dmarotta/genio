import { useEffect, useMemo, useRef, useState } from 'react'
import { Bug, ChevronDown, ChevronRight, Play as PlayIcon, RefreshCw, RotateCcw, Square } from 'lucide-react'
import { sameSource, UNITY_SLOTS_ANCHOR, type PlayConsole, type PlayerInstanceStatus, type PlayerSourceOption } from '@shared/play'
import { PROJECT_WINDOW, api, errText, go } from '../store'
import { cx } from '../lib/format'
import { openGenioPanel, useScreenContext } from '../lib/screen-context'
import { PROBLEMS, SOURCE_GROUPS, STATE_LABEL, STEPS, WORKING, bytes, clock, deletionText, firstCopyWarning, playedText, progressText, sourceText, stepIndex, syncSummary } from '../lib/play-screen'
import { requestSystemsSection } from './Systems'
import { PlayLive } from './PlayLive'
import '../styles/play.css'

const STREAM = { width: 1280, height: 720 }
type Entry = PlayConsole['entries'][number]

/** The Play screen: your own Unity instance for this project, playing any source (main, worktrees, units, branches). */
export function Play() {
  if (!PROJECT_WINDOW) return <div className="view play-view"><h1 className="title">Play</h1><p className="dim">Open Play from a project window.</p></div>
  return <PlayScreen world={PROJECT_WINDOW} />
}

function PlayScreen({ world }: { world: string }) {
  const [status, setStatus] = useState<PlayerInstanceStatus>()
  const [sources, setSources] = useState<PlayerSourceOption[]>()
  const [choice, setChoice] = useState<string>()
  const [estimate, setEstimate] = useState<number>()
  const [idleMinutes, setIdleMinutes] = useState(10)
  const [confirmCopy, setConfirmCopy] = useState(false)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [drawer, setDrawer] = useState(false)
  const [logs, setLogs] = useState<Entry[]>([])
  const [consoleNote, setConsoleNote] = useState('')
  const [streamEnded, setStreamEnded] = useState<string>()
  const [shot, setShot] = useState<string>()
  const fast = useRef(false)
  const confirmBox = useRef<HTMLDivElement>(null)

  // Instance status: every second while something runs, every three otherwise; the countdown ticks locally.
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      try { const s = await api().playerInstanceStatus(world); if (live) setStatus(s) } catch (e) { if (live) setError(errText(e)) }
      if (live) timer = setTimeout(() => void poll(), fast.current ? 1000 : 3000)
    }
    void poll()
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => { live = false; clearTimeout(timer); clearInterval(tick) }
  }, [world])
  const state = status?.state
  fast.current = !!busy || (!!state && WORKING.has(state))

  const loadSources = async (): Promise<void> => {
    try { setSources(await api().playerSources(world)) } catch (e) { setError(errText(e)) }
  }
  useEffect(() => {
    void loadSources()
    void api().playerInstanceMachine(world).then(m => setIdleMinutes(m.settings.idleMinutes)).catch(() => {})
  }, [world])
  // Preselect what the instance plays, else the main checkout.
  useEffect(() => {
    if (!sources || (choice && sources.some(o => o.id === choice))) return
    setChoice((sources.find(o => sameSource(o.source, status?.source)) ?? sources[0])?.id)
  }, [sources, status?.source])
  // The first Play copies the whole project: measure it once while no copy exists.
  const hasCopy = !!status?.copy
  useEffect(() => {
    if (!status || hasCopy || estimate !== undefined) return
    let live = true
    void api().playerCopySizes(world).then(s => { if (live && s.estimate) setEstimate(s.estimate.totalBytes) }).catch(() => {})
    return () => { live = false }
  }, [world, !!status, hasCopy])
  // A stream that ended stays closed until the next Play session (or Reconnect).
  const playing = state === 'playing' || state === 'paused'
  useEffect(() => { if (playing) setStreamEnded(undefined) }, [playing])
  // Compile errors open the console; a stuck dialog fetches its screenshot.
  useEffect(() => { if (state === 'compile-errors') setDrawer(true) }, [state])
  useEffect(() => { if (confirmCopy) confirmBox.current?.scrollIntoView?.({ block: 'nearest' }) }, [confirmCopy])
  const dialogAt = status?.dialog?.screenshot
  useEffect(() => {
    setShot(undefined)
    if (!dialogAt) return
    let live = true
    void api().playerInstanceDialogShot(world).then(s => { if (live) setShot(s) }).catch(() => {})
    return () => { live = false }
  }, [world, dialogAt])

  // Console drawer: polled while open and Unity runs, from a cursor so entries never repeat.
  const running = !!status?.pid
  useEffect(() => {
    if (!drawer) return
    if (!running) { setConsoleNote('Unity is not running. Its console shows here while it runs.'); return }
    let live = true, cursor: number | undefined, consoleSession: string | undefined, timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      try {
        const c = await api().playerInstanceConsole(world, cursor, consoleSession)
        if (!live) return
        cursor = c.cursor; consoleSession = c.session
        setLogs(old => [...(c.reset ? [] : old), ...c.entries].slice(-300)); setConsoleNote('')
      } catch (e) { if (live) setConsoleNote(errText(e)) }
      if (live) timer = setTimeout(() => void poll(), 2000)
    }
    setLogs([]); void poll()
    return () => { live = false; clearTimeout(timer) }
  }, [world, drawer, running, status?.pid])

  const option = sources?.find(o => o.id === choice)
  const run = async (label: string, fn: () => Promise<PlayerInstanceStatus | void>): Promise<void> => {
    setBusy(label); setError('')
    try { const s = await fn(); if (s) setStatus(s) }
    catch (e) { const m = errText(e); if (!/Play cancelled/.test(m)) setError(m) }
    finally {
      setBusy(undefined)
      try { setStatus(await api().playerInstanceStatus(world)) } catch { /* next poll */ }
    }
  }
  const play = (opts: { startAnyway?: boolean; confirmed?: boolean } = {}): void => {
    if (!option) return
    if (!hasCopy && !opts.confirmed) { setConfirmCopy(true); return }
    setConfirmCopy(false)
    void run('play', () => api().playerInstancePlay(world, option.source, opts.startAnyway ? { startAnyway: true } : {}))
  }
  const stop = (): void => void run('stop', () => api().playerInstanceStop(world))
  const restart = (visible = false): void => void run(visible ? 'visible' : 'restart', () => api().playerInstanceRestart(world, visible))
  const quit = (): void => void run('quit', () => api().playerInstanceQuit(world))
  const keep = (): void => void run('keep', () => api().playerInstanceKeepAlive(world))
  const settings = (): void => { requestSystemsSection('project', UNITY_SLOTS_ANCHOR); go('systems') }

  const working = !!busy || (!!state && WORKING.has(state))
  const warm = state === 'ready'
  // Low memory asks first, before copying: the Unity button itself becomes the one-click override.
  const startAnyway = state === 'low-memory' && !status?.lowMemory?.hard
  const countdown = warm && status?.deadline ? status.deadline - now : undefined
  const keepMinutes = status?.deadline && status.stoppedAt ? Math.round((status.deadline - status.stoppedAt) / 60000) : idleMinutes
  const progress = progressText(status?.copy?.progress, now)
  const deletion = deletionText(status?.copy)
  const synced = syncSummary(status?.copy)
  const played = playedText(status)
  const step = stepIndex(state)
  const lastError = [...logs].reverse().find(l => /error|exception|assert/i.test(l.level ?? ''))
  const grouped = useMemo(() => SOURCE_GROUPS.map(g => ({ ...g, options: (sources ?? []).filter(o => o.group === g.group) })).filter(g => g.options.length), [sources])

  useScreenContext('play', { facts: [
    { label: 'Instance', value: `${state ? STATE_LABEL[state] : 'loading'}${status?.message ? ` · ${status.message}` : ''}` },
    option && { label: 'Source', value: sourceText(option) },
    !!played && { label: 'Playing from', value: `${played}${synced ? ` · ${synced}` : ''}` },
    countdown !== undefined && { label: 'Idle', value: `Unity quits and the copy is deleted in ${clock(countdown)}` },
    !!progress && { label: 'Copy', value: progress },
    status?.dialog && { label: 'Blocking dialog', value: `${status.dialog.title}: ${status.dialog.text}` },
    !!error && { label: 'Error', value: error },
    lastError && { label: 'Last console error', value: lastError.message }
  ] })

  return <div className="view play-view">
    <header className="play-head">
      <div><div className="label">YOUR UNITY INSTANCE</div><h1 className="title">Play <span className="dim">· {world}</span></h1></div>
      <button className="btn sm ghost" onClick={openGenioPanel}>Ask Genio</button>
    </header>

    <div className="play-controls">
      <label className="play-source">
        <span className="label">Source</span>
        <select className="select" aria-label="Play source" value={choice ?? ''} disabled={!sources?.length} onChange={e => { setChoice(e.target.value); setConfirmCopy(false) }}>
          {!sources && <option value="">Loading sources…</option>}
          {grouped.map(g => <optgroup key={g.group} label={g.label}>{g.options.map(o => <option key={o.id} value={o.id}>{sourceText(o)}</option>)}</optgroup>)}
        </select>
        <button className="btn sm icon ghost" title="Refresh sources" aria-label="Refresh sources" onClick={() => void loadSources()}><RefreshCw size={13} /></button>
      </label>
      <div className="play-buttons">
        {startAnyway
          ? <button className="btn solid amber" disabled={!option || working} onClick={() => play({ startAnyway: true, confirmed: true })}><PlayIcon size={14} /> Start anyway</button>
          : <button className="btn solid" disabled={!option || working || state === 'close-stuck'} onClick={() => play()}><PlayIcon size={14} /> Play</button>}
        <button className="btn" disabled={!(playing || working) || busy === 'stop'} onClick={stop}><Square size={13} /> Stop</button>
        <button className="btn" disabled={!status?.source || working} title="Quit Unity and start it again on the same source" onClick={() => restart()}><RotateCcw size={13} /> Restart Unity</button>
      </div>
    </div>

    <ol className="play-steps" aria-label="Instance lifecycle">
      {STEPS.map((s, i) => <li key={s.label} className={cx(i === step && 'on', step > i && 'done')}>{s.label}</li>)}
    </ol>

    <p className={cx('play-status', state && PROBLEMS.has(state) && 'alert-text')} role="status">
      <span className={cx('play-dot', state)} aria-hidden />
      <strong>{state ? STATE_LABEL[state] : 'Loading'}</strong>
      {played && state !== 'idle' && <span className="dim"> · {played}</span>}
      {synced && (playing || warm) && <span className="dim"> · {synced}</span>}
      {status?.unityVersion && state !== 'idle' && <span className="mute"> · Unity {status.unityVersion}</span>}
    </p>
    {progress && <ProgressBar text={progress} done={status?.copy?.progress?.bytes?.done} total={status?.copy?.progress?.bytes?.total} />}
    {state === 'starting' && status?.startup && <pre className="play-startup mute">{status.startup}</pre>}
    {deletion && <p className="mute">{deletion}</p>}

    {confirmCopy && <div ref={confirmBox} className="play-callout amber" role="alertdialog" aria-label="First copy">
      <p>{estimate !== undefined ? firstCopyWarning(estimate, idleMinutes) : 'The first Play of this project copies all of it before Unity opens. Measuring its size…'}</p>
      <div className="play-callout-actions">
        <button className="btn sm solid amber" onClick={() => play({ confirmed: true })}>Copy and Play</button>
        <button className="btn sm ghost" onClick={() => setConfirmCopy(false)}>Cancel</button>
      </div>
    </div>}
    {!confirmCopy && !hasCopy && estimate !== undefined && state === 'idle' && <p className="mute">First Play copies about {bytes(estimate)} of this project; later Plays sync only what changed.</p>}

    <Problem status={status} shot={shot} busy={working}
      cancel={stop} restart={restart} quit={quit} settings={settings} showConsole={() => setDrawer(true)} />
    {error && !(state && PROBLEMS.has(state) && status?.message === error) && <p role="alert" className="alert-text">{error}</p>}

    {countdown !== undefined && <div className="play-callout" aria-label="Idle countdown">
      <p>Stopped. Unity stays warm for a quick replay of any source; the instance is deleted in <strong className="num">{clock(countdown)}</strong>.</p>
      <div className="play-callout-actions">
        <button className="btn sm" disabled={!!busy} onClick={keep}>Keep {keepMinutes} more min</button>
        <button className="btn sm ghost alert" disabled={!!busy} onClick={quit}>Quit now</button>
      </div>
    </div>}

    <div className="play-screen">
      {playing && !streamEnded
        ? <PlayLive world={world} width={STREAM.width} height={STREAM.height} input={status?.capabilities?.input !== false} onClosed={setStreamEnded} />
        : <div className="play-screen-empty">
          {playing ? <><span>{streamEnded}</span><button className="btn sm" onClick={() => setStreamEnded(undefined)}>Reconnect</button></>
            : <span className="mute">{working ? 'The game appears here once Unity enters Play.' : warm ? 'Unity is warm: press Play to replay any source quickly.' : 'Choose a source and press Play.'}</span>}
        </div>}
    </div>
    {playing && status?.capabilities?.input === false && <p className="amber-text">This game reads legacy input, so it is view-only here. Input System games take keyboard, mouse and gamepad.</p>}

    <section className={cx('play-console', drawer && 'open')}>
      <button className="play-console-toggle" aria-expanded={drawer} onClick={() => setDrawer(d => !d)}>
        {drawer ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Unity console{logs.length ? ` (${logs.length})` : ''}
      </button>
      {drawer && <div className="play-console-body" aria-label="Unity console">
        {consoleNote && <p className="mute">{consoleNote}</p>}
        {logs.map((l, i) => <pre key={`${l.seq ?? 'x'}-${i}`} className={cx(/error|exception|assert/i.test(l.level ?? '') && 'alert-text', /warn/i.test(l.level ?? '') && 'amber-text')}>{l.message}{l.stackTrace ? `\n${l.stackTrace}` : ''}</pre>)}
        {!consoleNote && !logs.length && <p className="mute">No console entries yet.</p>}
      </div>}
    </section>

    <footer className="play-foot">
      <button className="btn sm ghost" disabled={!status?.source || working} title="Restart this instance as a normal window to see what Unity shows" onClick={() => restart(true)}><Bug size={13} /> Open this instance visibly</button>
      <button className="btn sm ghost" onClick={settings}>Idle time and editor limit</button>
    </footer>
  </div>
}

function ProgressBar({ text, done, total }: { text: string; done?: number; total?: number }) {
  const pct = total ? Math.min(100, Math.round(((done ?? 0) / total) * 100)) : undefined
  return <div className="play-progress">
    <div className="play-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><span style={{ width: `${pct ?? 100}%` }} className={cx(pct === undefined && 'indeterminate')} /></div>
    <span className="mute">{text}</span>
  </div>
}

/** Each problem state with its one clear action. */
function Problem({ status, shot, busy, cancel, restart, quit, settings, showConsole }: {
  status?: PlayerInstanceStatus; shot?: string; busy: boolean
  cancel: () => void; restart: (visible?: boolean) => void; quit: () => void; settings: () => void; showConsole: () => void
}) {
  if (!status || !PROBLEMS.has(status.state)) return null
  const message = status.message ?? STATE_LABEL[status.state]
  const body = (() => {
    switch (status.state) {
      case 'low-memory': return <button className="btn sm ghost" disabled={busy} onClick={cancel}>Cancel</button>
      case 'missing-editor': return <span className="mute">Install that version in Unity Hub, then press Play again.</span>
      case 'limit-reached': return <button className="btn sm" onClick={settings}>Open the editor limit</button>
      case 'compile-errors': return <button className="btn sm" onClick={showConsole}>Show the console</button>
      case 'crashed': return <span className="mute">{status.exitCode !== undefined ? `Exit code ${status.exitCode}. ` : ''}Press Play to start it again.</span>
      case 'close-stuck': return <button className="btn sm alert" disabled={busy} onClick={quit}>Close again</button>
      case 'stuck-dialog': return <>
        <button className="btn sm" disabled={busy || !status.source} onClick={() => restart()}>Restart Unity</button>
        <button className="btn sm amber" disabled={busy || !status.source} onClick={() => restart(true)}>Open this instance visibly</button>
      </>
      default: return null
    }
  })()
  return <div className={cx('play-callout', status.state === 'low-memory' || status.state === 'stuck-dialog' ? 'amber' : 'alert')} role="alert">
    <p>{message}</p>
    {status.state === 'stuck-dialog' && status.dialog && <div className="play-dialog">
      <strong>{status.dialog.title || 'Untitled dialog'}</strong>
      {status.dialog.text && <span>{status.dialog.text}</span>}
      {status.dialog.buttons.length > 0 && <span className="mute">Buttons: {status.dialog.buttons.join(' · ')}</span>}
      {shot && <img src={shot} alt="Screenshot of the hidden desktop when the dialog blocked Unity" />}
    </div>}
    {body && <div className="play-callout-actions">{body}</div>}
  </div>
}
