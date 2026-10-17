import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, GitBranch, MoreHorizontal, Pause, Play as PlayIcon, Power, RotateCcw, StepForward, Volume2, VolumeX, X } from 'lucide-react'
import { PLAYER_INSTANCE_ANCHOR, sameSource, sourceGoneText, type PlayConsole, type PlayerInstanceStatus, type PlayerScene, type PlayerSourceOption } from '@shared/play'
import { controls, look, soundLook, type PlayButtonAction, type UnityAction } from '@shared/play-controls'
import { PROJECT_WINDOW, api, errText, useStore } from '../store'
import { onPlaySourceRequest, takePlaySource } from '../lib/play-nav'
import { cx } from '../lib/format'
import { useScreenContext } from '../lib/screen-context'
import { ACTION_LABEL, DEFAULT_RESOLUTION, RESOLUTIONS, SOURCE_GROUPS, WORKING, chipText, playLine, sourceText, type PlayLine, type PlayLineAction } from '../lib/play-screen'
import { openSettings } from '../lib/settings-nav'
import { PlayLive } from './PlayLive'
import { Popover } from '../components/Layer'
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
// The game sound mute, per project, the same way: a missing or blocked store plays the sound. Genio's own UI sounds
// (settings.sound) are a separate setting.
const mutedKey = (world: string): string => `genio.play.muted.${world}`
function savedMuted(world: string): boolean {
  try { return localStorage.getItem(mutedKey(world)) === '1' } catch { return false }
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
  const [muted, setMuted] = useState(() => savedMuted(world))
  const [heard, setHeard] = useState<boolean>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState('')
  const [drawer, setDrawer] = useState(false)
  const [logs, setLogs] = useState<Entry[]>([])
  const [consoleNote, setConsoleNote] = useState('')
  const [streamEnded, setStreamEnded] = useState<string>()
  const fast = useRef(false)
  const narrow = useNarrow()

  // Instance status: every second while something runs, every three otherwise.
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      try { const s = await api().playerInstanceStatus(world); if (live) setStatus(s) } catch (e) { if (live) setError(errText(e)) }
      if (live) timer = setTimeout(() => void poll(), fast.current ? 1000 : 3000)
    }
    void poll()
    return () => { live = false; clearTimeout(timer) }
  }, [world])
  const state = status?.state
  fast.current = !!busy || (!!state && WORKING.has(state))

  const loadSources = async (): Promise<PlayerSourceOption[] | undefined> => {
    try { const list = await api().playerSources(world); setSources(list); return list } catch (e) { setError(errText(e)); return undefined }
  }
  useEffect(() => { void loadSources() }, [world])
  // A unit merged and removed (or a new one deployed) changes the list at once: re-read it when the project's units change state.
  const units = useStore(s => s.snap.tasks.filter(t => t.project === world).map(t => `${t.id}:${t.state}`).join('|'))
  const seenUnits = useRef(units)
  useEffect(() => {
    if (seenUnits.current === units) return
    seenUnits.current = units; void loadSources()
  }, [units])
  // The periodic validity check: a checkout removed outside Genio drops out of the picker within seconds.
  const listed = useRef(sources); listed.current = sources
  useEffect(() => {
    const iv = setInterval(() => {
      const checkouts = (listed.current ?? []).filter(o => o.group === 'unit' || o.group === 'worktree')
      if (!checkouts.length) return
      void Promise.all(checkouts.map(o => api().playerSourceAvailable(world, o.source).catch(() => true)))
        .then(ok => { if (ok.some(v => !v)) void loadSources() })
    }, 10_000)
    return () => clearInterval(iv)
  }, [world])
  // Preselect what the instance plays, else the main checkout. A chosen source that left the list says so.
  const [missing, setMissing] = useState(false)
  const lastOption = useRef<PlayerSourceOption | undefined>(undefined)
  useEffect(() => {
    if (!sources || (choice && sources.some(o => o.id === choice))) return
    if (choice && lastOption.current?.id === choice) setMissing(true)
    setChoice((sources.find(o => sameSource(o.source, status?.source)) ?? sources[0])?.id)
  }, [sources, status?.source])
  // "Play this unit": a one-shot request preselects that unit, once, from a freshly read list.
  const [requested, setRequested] = useState(() => { const source = takePlaySource(world); return source ? { source } : undefined })
  useEffect(() => onPlaySourceRequest(r => { if (r.world === world) setRequested({ source: r.source }) }), [world])
  useEffect(() => {
    if (!requested) return
    let live = true
    void loadSources().then(list => {
      if (!live || !list) return
      const wanted = list.find(o => o.id === requested.source)
      if (wanted) setChoice(wanted.id)
      setMissing(!wanted)
      setRequested(undefined)
    })
    return () => { live = false }
  }, [requested])
  // The scene list: from the files while Unity is off, from Unity once it answers; re-read when it settles.
  const sceneMoment = state && LIVE_SCENES.has(state) ? `${state}:${status?.pid ?? ''}` : 'busy'
  useEffect(() => {
    if (sceneMoment === 'busy') return
    let live = true
    void api().playerInstanceScenes(world).then(s => { if (live) setScenes(s) }).catch(() => {})
    return () => { live = false }
  }, [world, sceneMoment])
  // A stream that ended stays closed until the next Play session (or Reconnect).
  const playing = state === 'playing' || state === 'paused'
  useEffect(() => { if (playing) setStreamEnded(undefined); else setHeard(undefined) }, [playing])

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
  if (option) lastOption.current = option
  const run = async (label: string, fn: () => Promise<PlayerInstanceStatus | void>): Promise<void> => {
    setBusy(label); setError(''); setMissing(false)
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
  const settings = (): void => openSettings('play', PLAYER_INSTANCE_ANCHOR)
  // A new source applies on the next ▶; while playing it re-plays at once. One that vanished since the list was read says so.
  const chooseSource = (id: string): void => {
    if (id === REFRESH) { void loadSources(); return }
    setChoice(id); setMissing(false)
    const next = sources?.find(o => o.id === id)
    if (!next) return
    void (async () => {
      const there = next.group === 'main' || await api().playerSourceAvailable(world, next.source).catch(() => true)
      if (!there) { setMissing(true); void loadSources(); return }
      if (playing && !sameSource(next.source, status?.source)) void run('enter', () => api().playerInstanceEnterPlay(world, next.source))
    })()
  }
  // The source vanished while loading: one click plays the main checkout, where a merged unit's work now is.
  const mainOption = sources?.find(o => o.group === 'main')
  const playMain = (): void => {
    if (!mainOption) return
    setChoice(mainOption.id)
    void run('enter', () => api().playerInstanceEnterPlay(world, mainOption.source))
  }
  const gone = status?.sourceGone
  // Off: kept for the next Play; ready: opened; playing: Genio exits, opens it and enters again.
  const chooseScene = (path: string): void => void run('scene', () => api().playerInstanceSetScene(world, path))
  const chooseResolution = (id: string): void => {
    setResolutionId(id)
    try { localStorage.setItem(resolutionKey(world), id) } catch { /* per-viewer convenience only */ }
  }
  const toggleMuted = (): void => {
    const next = !muted
    setMuted(next)
    try { localStorage.setItem(mutedKey(world), next ? '1' : '0') } catch { /* per-viewer convenience only */ }
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
  // The game view shows the game: the status line leaves the area, unless a problem needs saying.
  const live = playing && !streamEnded
  const line =playLine({ status, busy, error, missing, streamEnded: !!streamEnded })
  const lastError = [...logs].reverse().find(l => /error|exception|assert/i.test(l.level ?? ''))
  const grouped = useMemo(() => SOURCE_GROUPS.map(g => ({ ...g, options: (sources ?? []).filter(o => o.group === g.group) })).filter(g => g.options.length), [sources])
  const act = (action: PlayLineAction): void => {
    switch (action) {
      case 'retry': playPress('enter'); return
      case 'console': setDrawer(true); return
      case 'visible': restart(true); return
      case 'settings': settings(); return
      case 'reconnect': setStreamEnded(undefined); return
      case 'main': playMain()
    }
  }
  const actionOff = (action: PlayLineAction): boolean =>
    ((action === 'retry' || action === 'visible' || action === 'main') && working) || (action === 'retry' && !option) || (action === 'visible' && !status?.source) || (action === 'main' && !mainOption)

  // The detail the line leaves out stays visible to the floating Genio chat, never on the page.
  useScreenContext('play', { facts: [
    { label: 'Status', value: `${line.text}${status?.message ? ` · ${status.message}` : ''}` },
    option && { label: 'Source', value: sourceText(option) },
    !!gone && { label: 'Source gone', value: sourceGoneText(gone) },
    !!sceneName && { label: 'Scene', value: scene ?? sceneName },
    { label: 'Resolution', value: `${resolution.width} × ${resolution.height}` },
    { label: 'Audio', value: muted ? 'muted' : playing && heard === false ? 'no sound from the game' : 'on' },
    !!status?.unityVersion && { label: 'Unity', value: status.unityVersion },
    state === 'starting' && !!status?.startup && { label: 'Unity log', value: status.startup.split('\n').filter(Boolean).slice(-3).join(' · ') },
    status?.dialog && { label: 'Blocking dialog', value: `${status.dialog.title}: ${status.dialog.text}` },
    playing && status?.capabilities?.input === false && { label: 'Input', value: 'This game reads legacy input, so the stream is view-only' },
    !!streamEnded && { label: 'Live view', value: streamEnded },
    !!error && { label: 'Error', value: error },
    lastError && { label: 'Last console error', value: lastError.message }
  ] })

  const UnityIcon = { start: Power, 'start-anyway': AlertTriangle, cancel: X, stop: Power, restart: RotateCcw, 'close-again': Power }[bar.unity.action]
  // Starting Unity or entering Play needs a source; until the list loads both stay off and say so.
  const noSource = option ? undefined : 'Choose a source first'
  const unityOn = usable(bar.unity) && !((bar.unity.action === 'start' || bar.unity.action === 'start-anyway') && noSource)
  const playOn = usable(bar.play) && !(bar.play.action !== 'exit' && noSource)
  const looks = {
    unity: look('unity', bar.unity, unityOn, usable(bar.unity) ? noSource : undefined),
    play: look('play', bar.play, playOn, usable(bar.play) ? noSource : undefined),
    pause: look('pause', bar.pause, usable(bar.pause)),
    step: look('step', bar.step, usable(bar.step)),
    sound: soundLook(muted)
  }

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
      <button className={cx('btn sm play-unity', looks.unity.className)} disabled={!unityOn}
        title={looks.unity.title} aria-label={bar.unity.label} onClick={() => unityPress(bar.unity.action)}>
        <UnityIcon size={13} aria-hidden /><span className="play-unity-label">{bar.unity.label}</span>
      </button>
      <div className="play-transport">
        <button className={cx('btn sm icon', looks.play.className)} disabled={!playOn}
          title={looks.play.title} aria-label={bar.play.label} aria-pressed={looks.play.pressed} onClick={() => playPress(bar.play.action)}>
          <PlayIcon size={13} fill="currentColor" aria-hidden />
        </button>
        <button className={cx('btn sm icon', looks.pause.className)} disabled={!usable(bar.pause)} title={looks.pause.title} aria-label={bar.pause.label} aria-pressed={looks.pause.pressed} onClick={pause}><Pause size={13} fill="currentColor" aria-hidden /></button>
        <button className={cx('btn sm icon', looks.step.className)} disabled={!usable(bar.step)} title={looks.step.title} aria-label={bar.step.label} onClick={step}><StepForward size={13} fill="currentColor" aria-hidden /></button>
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
      <button className={cx('btn sm icon', looks.sound.className)} title={looks.sound.title} aria-label="Mute game sound" aria-pressed={looks.sound.pressed} onClick={toggleMuted}>
        {muted ? <VolumeX size={13} aria-hidden /> : <Volume2 size={13} aria-hidden />}
      </button>
    </div>

    <div className="play-screen">
      {live && <PlayLive world={world} width={resolution.width} height={resolution.height} input={status?.capabilities?.input !== false} muted={muted} onClosed={setStreamEnded} onError={setError} onSound={setHeard} />}
      {(!live || line.kind === 'problem') && <StatusLine line={line} detail={error || status?.message} over={live} onAction={act} actionOff={actionOff} />}
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

/**
 * The one status line, centered in the game area: a dot, the plain state or problem and at most one action, with the
 * progress bar under it while working. `over` is a problem shown while the game plays.
 */
function StatusLine({ line, detail, over, onAction, actionOff }: { line: PlayLine; detail?: string; over?: boolean; onAction: (a: PlayLineAction) => void; actionOff: (a: PlayLineAction) => boolean }) {
  const problem = line.kind === 'problem'
  return <div className={cx('play-status', problem && 'alert-text', over && 'over')} role="status" title={problem ? detail : undefined}>
    <p className="play-status-line">
      <span className={cx('play-dot', line.kind)} aria-hidden />
      <span className="play-status-text">{line.text}</span>
      {line.action && <button className="play-link" disabled={actionOff(line.action)} onClick={() => onAction(line.action!)}>{ACTION_LABEL[line.action]}</button>}
    </p>
    {line.bar !== undefined && <span className="play-progress-track" role="progressbar" aria-label={line.text} aria-valuemin={0} aria-valuemax={100} aria-valuenow={line.bar === 'indeterminate' ? undefined : line.bar}>
      <span style={{ width: `${line.bar === 'indeterminate' ? 100 : line.bar}%` }} className={cx(line.bar === 'indeterminate' && 'indeterminate')} />
    </span>}
  </div>
}

/** The ⋯ menu: the rare actions (Restart Unity, Open visibly, console, settings). */
function Overflow({ items }: { items: { label: string; disabled?: boolean; run: () => void }[] }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLButtonElement>('[role=menuitem]:not(:disabled)')?.focus()
  }, [open])
  return <div className="play-menu" ref={wrap}>
    <button className="btn sm icon ghost" aria-label="More Play actions" title="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}><MoreHorizontal size={15} /></button>
    {open && <Popover anchor={wrap} panel={panel} placement="bottom-end" className="play-menu-panel" role="menu" aria-label="More Play actions" onClose={() => setOpen(false)}>
      {items.map(it => <button key={it.label} role="menuitem" className="play-menu-item" disabled={it.disabled} onClick={() => { setOpen(false); it.run() }}>{it.label}</button>)}
    </Popover>}
  </div>
}
