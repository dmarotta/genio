import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, GitBranch, MoreHorizontal, Pause, Play as PlayIcon, Power, RotateCcw, Square, StepForward, X } from 'lucide-react'
import { PLAYER_INSTANCE_ANCHOR, sameSource, type PlayConsole, type PlayerInstanceStatus, type PlayerScene, type PlayerSourceOption } from '@shared/play'
import { controls, type PlayButtonAction, type UnityAction } from '@shared/play-controls'
import { PROJECT_WINDOW, api, errText, go } from '../store'
import { cx } from '../lib/format'
import { useScreenContext } from '../lib/screen-context'
import { DEFAULT_RESOLUTION, PROBLEMS, RESOLUTIONS, SOURCE_GROUPS, STATE_LABEL, WORKING, chipText, clock, deletionText, firstCopyText, playedText, progressText, sourceText, statusText, syncSummary } from '../lib/play-screen'
import { requestSystemsSection } from './Systems'
import { PlayLive } from './PlayLive'
import '../styles/play.css'

type Entry = PlayConsole['entries'][number]
const REFRESH = '__refresh'
const LIVE_SCENES = new Set(['idle', 'ready', 'playing', 'paused', 'compile-errors', 'crashed', 'error'])

/** The Play screen: your own Unity instance for this project, playing any source (main, worktrees, units, branches). */
export function Play() {
  if (!PROJECT_WINDOW) return <div className="view play-view"><h1 className="title">Play</h1><p className="dim">Open Play from a project window.</p></div>
  return <PlayScreen world={PROJECT_WINDOW} />
}

// The chosen resolution, per project: a per-viewer convenience, so a missing or blocked store falls back to 720p.
const resolutionKey = (world: string): string => `genio.play.resolution.${world}`
function savedResolution(world: string): string {
  try { return localStorage.getItem(resolutionKey(world)) ?? DEFAULT_RESOLUTION.id } catch { return DEFAULT_RESOLUTION.id }
}

/** ≤ 520 px wide or ≤ 420 px tall: the narrow pop-out layout with short labels. */
function useNarrow(): boolean {
  const query = '(max-width: 520px), (max-height: 420px)'
  const [narrow, setNarrow] = useState(() => !!window.matchMedia?.(query).matches)
  useEffect(() => {
    const m = window.matchMedia?.(query)
    if (!m) return
    const on = (): void => setNarrow(m.matches)
    m.addEventListener?.('change', on)
    return () => m.removeEventListener?.('change', on)
  }, [])
  return narrow
}

function PlayScreen({ world }: { world: string }) {
  const [status, setStatus] = useState<PlayerInstanceStatus>()
  const [sources, setSources] = useState<PlayerSourceOption[]>()
  const [choice, setChoice] = useState<string>()
  const [scenes, setScenes] = useState<PlayerScene[]>([])
  const [resolutionId, setResolutionId] = useState(() => savedResolution(world))
  const [estimate, setEstimate] = useState<number>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [drawer, setDrawer] = useState(false)
  const [logs, setLogs] = useState<Entry[]>([])
  const [consoleNote, setConsoleNote] = useState('')
  const [streamEnded, setStreamEnded] = useState<string>()
  const [shot, setShot] = useState<string>()
  const fast = useRef(false)
  const narrow = useNarrow()

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
  useEffect(() => { void loadSources() }, [world])
  // Preselect what the instance plays, else the main checkout.
  useEffect(() => {
    if (!sources || (choice && sources.some(o => o.id === choice))) return
    setChoice((sources.find(o => sameSource(o.source, status?.source)) ?? sources[0])?.id)
  }, [sources, status?.source])
  // The scene list: from the files while Unity is off, from Unity once it answers; re-read when it settles.
  const sceneMoment = state && LIVE_SCENES.has(state) ? `${state}:${status?.pid ?? ''}` : 'busy'
  useEffect(() => {
    if (sceneMoment === 'busy') return
    let live = true
    void api().playerInstanceScenes(world).then(s => { if (live) setScenes(s) }).catch(() => {})
    return () => { live = false }
  }, [world, sceneMoment])
  // What the first start copies, for Genio's screen context only: measured once while no copy exists.
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
  const scene = status?.scene ?? scenes.find(s => s.active)?.path
  const sceneName = scenes.find(s => s.path === scene)?.name ?? scene?.replace(/^.*\/|\.unity$/g, '')
  const resolution = RESOLUTIONS.find(r => r.id === resolutionId) ?? DEFAULT_RESOLUTION

  const bar = controls(state, { hard: !!status?.lowMemory?.hard })
  // Cancel, Stop and Exit Play interrupt a call in flight; every other press waits for it.
  const usable = (c: { enabled: boolean; action: string }): boolean => c.enabled && (!busy || (['cancel', 'stop', 'close-again', 'exit'].includes(c.action) && busy !== c.action))
  const unityPress = (action: UnityAction): void => {
    switch (action) {
      case 'start': case 'start-anyway': if (option) void run(action, () => api().playerInstanceStartUnity(world, option.source, action === 'start-anyway' ? { startAnyway: true } : {})); return
      case 'cancel': case 'stop': case 'close-again': void run(action, () => api().playerInstanceStopUnity(world)); return
      case 'restart': void run(action, () => api().playerInstanceRestart(world)); return
    }
  }
  const playPress = (action: PlayButtonAction): void => {
    if (action === 'exit') { void run('exit', () => api().playerInstanceExitPlay(world)); return }
    if (option) void run(action, () => api().playerInstanceEnterPlay(world, option.source, action === 'enter-anyway' ? { startAnyway: true } : {}))
  }
  const pause = (): void => void run('pause', () => api().playerInstancePause(world))
  const step = (): void => void run('step', () => api().playerInstanceStep(world))
  const restart = (visible = false): void => void run(visible ? 'visible' : 'restart', () => api().playerInstanceRestart(world, visible))
  const keep = (): void => void run('keep', () => api().playerInstanceKeepAlive(world))
  const settings = (): void => { requestSystemsSection('play', PLAYER_INSTANCE_ANCHOR); go('systems') }
  // A new source applies on the next ▶; while playing it re-plays at once.
  const chooseSource = (id: string): void => {
    if (id === REFRESH) { void loadSources(); return }
    setChoice(id)
    const next = sources?.find(o => o.id === id)
    if (next && playing && !sameSource(next.source, status?.source)) void run('enter', () => api().playerInstanceEnterPlay(world, next.source))
  }
  // Off: kept for the next Play; ready: opened; playing: Genio exits, opens it and enters again.
  const chooseScene = (path: string): void => void run('scene', () => api().playerInstanceSetScene(world, path))
  const chooseResolution = (id: string): void => {
    setResolutionId(id)
    try { localStorage.setItem(resolutionKey(world), id) } catch { /* per-viewer convenience only */ }
  }

  // Unity's shortcuts while the game does not hold the keyboard: Ctrl+P Play, Ctrl+Shift+P pause, Ctrl+Alt+P step.
  const keys = useRef({ bar, usable, playPress, pause, step })
  keys.current = { bar, usable, playPress, pause, step }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.code !== 'KeyP' || e.metaKey || (e.target as HTMLElement | null)?.tagName === 'CANVAS') return
      const k = keys.current
      const target = e.altKey ? (k.usable(k.bar.step) && k.step) : e.shiftKey ? (k.usable(k.bar.pause) && k.pause) : (k.usable(k.bar.play) && (() => k.playPress(k.bar.play.action)))
      e.preventDefault()
      if (target) target()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const working = !!busy || (!!state && WORKING.has(state))
  const countdown = state === 'ready' && status?.deadline ? status.deadline - now : undefined
  const copyDeadline = !status?.pid && status?.copy?.deadline ? status.copy.deadline - now : undefined
  const progress = progressText(status?.copy?.progress, now)
  const copyBar = (state === 'copying' || state === 'syncing') && progress ? progress : undefined
  const synced = syncSummary(status?.copy)
  const played = playedText(status)
  const lastError = [...logs].reverse().find(l => /error|exception|assert/i.test(l.level ?? ''))
  const grouped = useMemo(() => SOURCE_GROUPS.map(g => ({ ...g, options: (sources ?? []).filter(o => o.group === g.group) })).filter(g => g.options.length), [sources])

  // Everything the page no longer shows stays visible to the floating Genio chat.
  useScreenContext('play', { facts: [
    { label: 'Instance', value: `${state ? STATE_LABEL[state] : 'loading'}${status?.message ? ` · ${status.message}` : ''}` },
    option && { label: 'Source', value: sourceText(option) },
    !!played && { label: 'Playing from', value: `${played}${synced ? ` · ${synced}` : ''}` },
    !!sceneName && { label: 'Scene', value: scene ?? sceneName },
    { label: 'Resolution', value: `${resolution.width} × ${resolution.height}` },
    !!status?.unityVersion && { label: 'Unity', value: status.unityVersion },
    countdown !== undefined && { label: 'Idle', value: `Unity quits and the copy is deleted in ${clock(countdown)} if idle` },
    copyDeadline !== undefined && { label: 'Copy', value: `Kept for a quick start; deleted in ${clock(copyDeadline)}` },
    !!progress && { label: 'Copy progress', value: progress },
    !hasCopy && estimate !== undefined && { label: 'First start', value: `Copies the project first: ${firstCopyText(estimate)}` },
    !!deletionText(status?.copy) && { label: 'Deletion', value: deletionText(status?.copy)! },
    state === 'starting' && !!status?.startup && { label: 'Unity log', value: status.startup.split('\n').filter(Boolean).slice(-3).join(' · ') },
    status?.lowMemory && { label: 'Memory', value: status.message ?? 'Not enough memory' },
    status?.dialog && { label: 'Blocking dialog', value: `${status.dialog.title}: ${status.dialog.text}` },
    playing && status?.capabilities?.input === false && { label: 'Input', value: 'This game reads legacy input, so the stream is view-only' },
    !!error && { label: 'Error', value: error },
    lastError && { label: 'Last console error', value: lastError.message }
  ] })

  const tone = error || (state && PROBLEMS.has(state)) ? (state === 'low-memory' || state === 'stuck-dialog') && !error ? 'amber-text' : 'alert-text' : undefined
  const UnityIcon = { start: Power, 'start-anyway': AlertTriangle, cancel: X, stop: Power, restart: RotateCcw, 'close-again': Power }[bar.unity.action]

  return <div className={cx('view play-view', narrow && 'narrow')}>
    <header className="play-head">
      <h1 className="title">Play{!narrow && <span className="dim play-world"> {world}</span>}</h1>
      <label className="play-chip" title={option ? sourceText(option) : 'Play source'}>
        <GitBranch size={12} aria-hidden /><span>{option ? chipText(option) : 'Loading…'}</span><ChevronDown size={12} aria-hidden />
        <select aria-label="Play source" value={choice ?? ''} disabled={!sources?.length} onChange={e => chooseSource(e.target.value)}>
          {!sources && <option value="">Loading sources…</option>}
          {grouped.map(g => <optgroup key={g.group} label={g.label}>{g.options.map(o => <option key={o.id} value={o.id}>{sourceText(o)}</option>)}</optgroup>)}
          {!!sources && <option value={REFRESH}>Refresh sources</option>}
        </select>
      </label>
      <Overflow items={[
        { label: 'Restart Unity', disabled: !status?.source || working, run: () => restart() },
        { label: 'Open Unity visibly (debug)', disabled: !status?.source || working, run: () => restart(true) },
        { label: 'Unity console', run: () => setDrawer(true) },
        { label: 'Idle time and editor limit…', run: settings }
      ]} />
    </header>

    <div className="play-toolbar" role="toolbar" aria-label="Play controls">
      <button className={cx('btn sm play-unity', bar.unity.warn && 'amber solid', bar.unity.action === 'start' && 'solid')} disabled={!usable(bar.unity) || ((bar.unity.action === 'start' || bar.unity.action === 'start-anyway') && !option)}
        title={bar.unity.label} aria-label={bar.unity.label} onClick={() => unityPress(bar.unity.action)}>
        <UnityIcon size={13} aria-hidden /><span className="play-unity-label">{bar.unity.label}</span>
      </button>
      <div className="play-transport">
        <button className={cx('btn sm icon', bar.play.active && 'on', bar.play.action === 'enter-anyway' && 'amber')} disabled={!usable(bar.play) || (bar.play.action !== 'exit' && !option)}
          title={`${bar.play.label} (Ctrl+P)`} aria-label={bar.play.label} aria-pressed={!!bar.play.active} onClick={() => playPress(bar.play.action)}>
          {bar.play.action === 'exit' ? <Square size={12} aria-hidden /> : <PlayIcon size={13} aria-hidden />}
        </button>
        <button className={cx('btn sm icon', bar.pause.active && 'on')} disabled={!usable(bar.pause)} title={`${bar.pause.label} (Ctrl+Shift+P)`} aria-label={bar.pause.label} aria-pressed={!!bar.pause.active} onClick={pause}><Pause size={13} aria-hidden /></button>
        <button className="btn sm icon" disabled={!usable(bar.step)} title="Step one frame (Ctrl+Alt+P)" aria-label={bar.step.label} onClick={step}><StepForward size={13} aria-hidden /></button>
      </div>
      <span className="play-toolbar-gap" />
      <label className="play-pick" title={scene}>
        {!narrow && <span className="label">Scene</span>}
        <select className="select" aria-label="Scene" value={scene ?? ''} disabled={!bar.scene.enabled || !!busy || !scenes.length} onChange={e => chooseScene(e.target.value)}>
          {!scene && <option value="">{scenes.length ? 'Choose a scene' : 'No scenes'}</option>}
          {scene && !scenes.some(s => s.path === scene) && <option value={scene}>{sceneName}</option>}
          {scenes.map(s => <option key={s.path} value={s.path} title={s.path}>{s.name}</option>)}
        </select>
      </label>
      <select className="select play-res" aria-label="Resolution" value={resolution.id} disabled={!bar.resolution.enabled} onChange={e => chooseResolution(e.target.value)}>
        {RESOLUTIONS.map(r => <option key={r.id} value={r.id}>{narrow ? r.short : r.label}</option>)}
      </select>
    </div>

    {copyBar || state === 'starting'
      ? <ProgressBar text={copyBar ?? 'Starting Unity…'} title={state === 'starting' ? status?.startup?.trim().split('\n').pop() : undefined}
        done={copyBar ? status?.copy?.progress?.bytes?.done : undefined} total={copyBar ? status?.copy?.progress?.bytes?.total : undefined} />
      : <p className={cx('play-status', tone)} role="status">
        <span className={cx('play-dot', state)} aria-hidden />
        {state === 'low-memory' && <AlertTriangle size={12} aria-hidden />}
        <span className="play-status-text" title={error || status?.message}>{error || statusText(status, sceneName)}</span>
        {state === 'compile-errors' && <button className="play-link" onClick={() => setDrawer(true)}>Show console</button>}
        {state === 'limit-reached' && <button className="play-link" onClick={settings}>Settings</button>}
        {countdown !== undefined && <button className="play-link play-idle" title="Keep Unity open longer" onClick={keep} disabled={!!busy}>quits in {clock(countdown)} if idle</button>}
      </p>}

    <div className="play-screen">
      {playing && !streamEnded
        ? <PlayLive world={world} width={resolution.width} height={resolution.height} input={status?.capabilities?.input !== false} onClosed={setStreamEnded} onError={setError} />
        : state === 'stuck-dialog' && status?.dialog
          ? <div className="play-dialog">
            <strong>{status.dialog.title || 'Untitled dialog'}</strong>
            {status.dialog.text && <span>{status.dialog.text}</span>}
            {status.dialog.buttons.length > 0 && <span className="mute">Buttons: {status.dialog.buttons.join(' · ')}</span>}
            {shot && <img src={shot} alt="Screenshot of the hidden desktop when the dialog blocked Unity" />}
            <button className="btn sm amber" disabled={working || !status.source} onClick={() => restart(true)}>Open Unity visibly</button>
          </div>
          : <div className="play-screen-empty">
            {playing ? <><span>{streamEnded}</span><button className="btn sm" onClick={() => setStreamEnded(undefined)}>Reconnect</button></>
              : <span className="mute">{emptyText(state)}</span>}
          </div>}
    </div>

    {drawer && <section className="play-console" aria-label="Unity console">
      <header className="play-console-head">
        <span>Unity console{logs.length ? ` (${logs.length})` : ''}</span>
        <button className="btn sm icon ghost" aria-label="Close the console" title="Close" onClick={() => setDrawer(false)}><X size={13} /></button>
      </header>
      <div className="play-console-body">
        {consoleNote && <p className="mute">{consoleNote}</p>}
        {logs.map((l, i) => <pre key={`${l.seq ?? 'x'}-${i}`} className={cx(/error|exception|assert/i.test(l.level ?? '') && 'alert-text', /warn/i.test(l.level ?? '') && 'amber-text')}>{l.message}{l.stackTrace ? `\n${l.stackTrace}` : ''}</pre>)}
        {!consoleNote && !logs.length && <p className="mute">No console entries yet.</p>}
      </div>
    </section>}
  </div>
}

function emptyText(state: PlayerInstanceStatus['state'] | undefined): string {
  switch (state) {
    case 'copying': case 'syncing': return 'Copying…'
    case 'starting': return 'Starting Unity…'
    case 'entering-play': return 'Entering Play…'
    case 'ready': return 'Press ▶ to enter Play.'
    case 'exiting-play': case 'shutting-down': return ''
    default: return 'Press ▶ to play, or start Unity first.'
  }
}

function ProgressBar({ text, title, done, total }: { text: string; title?: string; done?: number; total?: number }) {
  const pct = total ? Math.min(100, Math.round(((done ?? 0) / total) * 100)) : undefined
  return <div className="play-progress" role="status" title={title}>
    <div className="play-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><span style={{ width: `${pct ?? 100}%` }} className={cx(pct === undefined && 'indeterminate')} /></div>
    <span className="mute">{text}</span>
  </div>
}

/** The ⋯ menu: the rare actions (Restart Unity, Open visibly, console, settings). */
function Overflow({ items }: { items: { label: string; disabled?: boolean; run: () => void }[] }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent): void => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', esc)
    wrap.current?.querySelector<HTMLButtonElement>('[role=menuitem]:not(:disabled)')?.focus()
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc) }
  }, [open])
  return <div className="play-menu" ref={wrap}>
    <button className="btn sm icon ghost" aria-label="More Play actions" title="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}><MoreHorizontal size={15} /></button>
    {open && <div className="play-menu-panel" role="menu" aria-label="More Play actions">
      {items.map(it => <button key={it.label} role="menuitem" className="play-menu-item" disabled={it.disabled} onClick={() => { setOpen(false); it.run() }}>{it.label}</button>)}
    </div>}
  </div>
}
