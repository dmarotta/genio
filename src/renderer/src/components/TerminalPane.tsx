import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { ChevronDown, RotateCcw, SquareTerminal, X } from 'lucide-react'
import type { TerminalInfo } from '@shared/types'
import { MAIN_CWD, formatDuration, type PaneCwd } from '@shared/terminal-pane'
import { PROJECT_WINDOW, api, errText, getState, setState, useStore } from '../store'
import { cx } from '../lib/format'
import {
  PANE_SHORTCUT, clampPaneHeight, isPaneShortcut, paneTerminals, readPanePrefs, togglePane, writePanePrefs
} from '../lib/terminal-pane'
import '../styles/terminal-pane.css'

// xterm (about 400 KB) loads when the pane first opens, not with every project window; once loaded it renders at once.
type View = typeof import('./Terminal')['TerminalView']
let loadedView: View | undefined
const loadView = (): Promise<View> => import('./Terminal').then(m => (loadedView = m.TerminalView))
const LazyView = lazy(() => loadView().then(view => ({ default: view })))
/** Load the terminal's code ahead of the pane's first open (the window's idle preload). */
export const preloadPaneTerminal = (): Promise<unknown> => loadedView ? Promise.resolve() : loadView()
function PaneTerminal(props: { id: string }) {
  const View = loadedView
  return View ? <View {...props} pane /> : <Suspense fallback={null}><LazyView {...props} pane /></Suspense>
}

/**
 * The player's own terminal, sliding up under every screen of a project window (Ctrl+` or the
 * title bar button), like the integrated terminal in VS Code and Codex. Hide keeps the shell
 * running; Close stops it. '!' commands from the chat open here as tabs.
 */
export function TerminalPane() {
  return PROJECT_WINDOW ? <ProjectTerminalPane project={PROJECT_WINDOW} /> : null
}

function ProjectTerminalPane({ project }: { project: string }) {
  const open = useStore((s) => s.paneOpen)
  const tab = useStore((s) => s.paneTab)
  const cwd = useStore((s) => s.paneCwd)
  const error = useStore((s) => s.paneError)
  const terminals = useStore((s) => s.terminals)
  const unitsKey = useStore((s) => s.snap.tasks.map((t) => `${t.id}:${t.state}`).join(','))
  const mine = useMemo(() => paneTerminals(terminals, project), [terminals, project])
  const shell = mine.find((t) => t.run === undefined)
  const runs = mine.filter((t) => t.run !== undefined)
  const [prefs] = useState(() => readPanePrefs(project))
  const [height, setHeight] = useState(prefs.height)
  const [available, setAvailable] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [starting, setStarting] = useState(false)
  const [choices, setChoices] = useState<PaneCwd[]>([])
  const pane = useRef<HTMLDivElement>(null)
  // Before the column is measured (or when it reports nothing), the window is the bound.
  const room = available || window.innerHeight
  const shown = clampPaneHeight(height, room)
  const front = runs.find((t) => t.id === tab)

  useEffect(() => { if (prefs.open) setState({ paneOpen: true }) }, [prefs])
  useEffect(() => { writePanePrefs(project, { height, open }) }, [project, height, open])
  // The answer cards and toasts keep clear of the pane.
  useEffect(() => {
    document.documentElement.style.setProperty('--term-pane-h', `${open ? shown : 0}px`)
    return () => { document.documentElement.style.removeProperty('--term-pane-h') }
  }, [open, shown])

  useLayoutEffect(() => {
    const column = pane.current?.parentElement
    if (!column) return
    const fit = (): void => setAvailable(column.clientHeight)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(column)
    window.addEventListener('resize', fit)
    return () => { ro.disconnect(); window.removeEventListener('resize', fit) }
  }, [])

  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent): void => {
      if (!isPaneShortcut(e)) return
      e.preventDefault()
      togglePane()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  const start = useCallback(async (restart = false, cwdId = getState().paneCwd): Promise<void> => {
    setStarting(true)
    try {
      const t = await api().paneOpen(project, cwdId, restart)
      setState((s) => ({ paneError: undefined, terminals: { ...s.terminals, [t.id]: t }, paneTab: restart ? undefined : s.paneTab }))
    } catch (e) {
      setState({ paneError: errText(e) })
    } finally {
      setStarting(false)
    }
  }, [project])

  // Opening the pane starts its shell once; a shell that ended waits for Restart. The terminal's code loads
  // meanwhile, so the shell renders (and takes focus) as soon as it starts.
  const autoStarted = useRef(false)
  useEffect(() => {
    if (!open) { autoStarted.current = false; return }
    if (!loadedView) void loadView().catch(() => undefined)
    if (shell || autoStarted.current) return
    autoStarted.current = true
    void start()
  }, [open, shell, start])

  // Folders: the main checkout and each live unit's copy; a copy that went away falls back to the main checkout.
  useEffect(() => {
    if (!open) return
    let gone = false
    void api().paneCwds(project).then((list) => {
      if (gone) return
      setChoices(list)
      if (!list.some((c) => c.id === getState().paneCwd)) setState({ paneCwd: MAIN_CWD })
    }).catch(() => undefined)
    return () => { gone = true }
  }, [open, project, unitsKey])

  // Keyboard focus follows the pane: into its terminal when it opens, out when it hides.
  useEffect(() => {
    const el = pane.current
    if (!el) return
    if (!open) {
      if (el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
      return
    }
    const id = requestAnimationFrame(() => el.querySelector<HTMLTextAreaElement>('.term-pane-view.on .xterm-helper-textarea')?.focus())
    return () => cancelAnimationFrame(id)
  }, [open, tab, shell?.id])

  const close = (): void => {
    setState({ paneOpen: false, paneTab: undefined, paneError: undefined })
    void api().paneClose(project).catch(() => undefined)
  }
  const pickCwd = (id: string): void => {
    setState({ paneCwd: id, paneTab: undefined })
    void start(false, id)
  }
  const closeRun = (t: TerminalInfo): void => {
    if (getState().paneTab === t.id) setState({ paneTab: undefined })
    void api().terminalKill(t.id).catch(() => undefined)
  }

  const gesture = useRef<{ y: number; from: number } | null>(null)
  const grab = (e: PointerEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    gesture.current = { y: e.clientY, from: shown }
    setDragging(true)
  }
  const drag = (e: PointerEvent): void => {
    const g = gesture.current
    if (g) setHeight(clampPaneHeight(g.from + g.y - e.clientY, room))
  }
  const drop = (): void => { gesture.current = null; setDragging(false) }
  const nudge = (e: KeyboardEvent): void => {
    const step = e.key === 'ArrowUp' ? 20 : e.key === 'ArrowDown' ? -20 : 0
    if (!step) return
    e.preventDefault()
    setHeight(clampPaneHeight(shown + step, room))
  }

  const ended = shell && !shell.alive
  return (
    <div ref={pane} className={cx('term-pane', open && 'open', dragging && 'dragging')} style={{ height: open ? shown : 0 }}
      aria-label="Terminal" role="region" inert={!open}>
      <div className="term-pane-inner" style={{ height: shown }}>
        <div className="term-pane-grip" role="separator" aria-orientation="horizontal" aria-label="Resize terminal" tabIndex={0}
          aria-valuenow={shown} title="Drag, or use the arrow keys, to resize"
          onPointerDown={grab} onPointerMove={drag} onPointerUp={drop} onPointerCancel={drop} onKeyDown={nudge} />
        <header className="term-pane-bar">
          <div className="term-pane-tabs" role="tablist">
            <button role="tab" aria-selected={!front} className={cx('term-pane-tab', !front && 'on')} onClick={() => setState({ paneTab: undefined })}>
              <SquareTerminal size={13} /> Terminal{ended ? ' · ended' : ''}
            </button>
            {runs.map((t) => (
              <span key={t.id} className={cx('term-pane-tab run', front?.id === t.id && 'on', !t.alive && (t.exitCode === 0 ? 'ok' : 'bad'))}>
                <button role="tab" aria-selected={front?.id === t.id} title={`${t.run} · run by you`} onClick={() => setState({ paneTab: t.id })}>
                  <span className="mono">! {t.run}</span>
                  {!t.alive && <span className="term-pane-exit">{t.exitCode}</span>}
                </button>
                <button className="term-pane-tab-x" aria-label={`Close ${t.run}`} title="Close this run" onClick={() => closeRun(t)}><X size={11} /></button>
              </span>
            ))}
          </div>
          <select className="term-pane-cwd" aria-label="Terminal folder" title="Folder for the shell and ! commands. Switching restarts the shell there."
            value={choices.some((c) => c.id === cwd) ? cwd : MAIN_CWD} onChange={(e) => pickCwd(e.target.value)}>
            {(choices.length ? choices : [{ id: MAIN_CWD, label: 'Main checkout', path: '' }]).map((c) => (
              <option key={c.id} value={c.id} title={c.path}>{c.label}</option>
            ))}
          </select>
          <button className="btn sm ghost icon" aria-label="Restart terminal" title="Restart the shell" disabled={starting} onClick={() => void start(true)}><RotateCcw size={13} /></button>
          <button className="btn sm ghost icon" aria-label="Hide terminal" title={`Hide (${PANE_SHORTCUT}); the shell keeps running`} onClick={togglePane}><ChevronDown size={14} /></button>
          <button className="btn sm ghost icon" aria-label="Close terminal" title="Close: stops the shell and its runs" onClick={close}><X size={14} /></button>
        </header>
        <div className="term-pane-body">
          {shell && (
            <div className={cx('term-pane-view', !front && 'on')}>
              <PaneTerminal id={shell.id} />
              {ended && <ShellEnded t={shell} busy={starting} onRestart={() => void start(true)} />}
            </div>
          )}
          {!shell && !front && (
            <div className="term-pane-view on term-pane-empty" role="status">
              {starting ? <span className="mute">Starting the shell…</span>
                : error ? <><span className="alert-text">{error}</span><button className="btn sm" onClick={() => void start(true)}><RotateCcw size={12} /> Restart</button></>
                  : <><span className="mute">The terminal is closed.</span><button className="btn sm" onClick={() => void start(true)}><RotateCcw size={12} /> Restart</button></>}
            </div>
          )}
          {runs.map((t) => (
            <div key={t.id} className={cx('term-pane-view', front?.id === t.id && 'on')}>
              <PaneTerminal id={t.id} />
              <RunStatus t={t} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Instead of a bare "session closed": how the shell ended, and a way back. */
function ShellEnded({ t, busy, onRestart }: { t: TerminalInfo; busy: boolean; onRestart: () => void }) {
  const why = t.startError ? `The shell could not start: ${t.startError}`
    : t.exitCode === 0 ? 'The shell ended (exit code 0): it was closed from inside, e.g. with exit.'
      : `The shell ended with exit code ${t.exitCode ?? 'unknown'}.`
  return (
    <div className="term-pane-ended" role="status">
      <span className={t.exitCode === 0 ? 'mute' : 'alert-text'}>{why}</span>
      <button className="btn sm" disabled={busy} onClick={onRestart}><RotateCcw size={12} /> Restart</button>
    </div>
  )
}

function RunStatus({ t }: { t: TerminalInfo }) {
  const took = t.exitedAt && t.processStartedAt ? ` · ${formatDuration(t.exitedAt - t.processStartedAt)}` : ''
  return (
    <div className={cx('term-pane-run', !t.alive && (t.exitCode === 0 ? 'ok' : 'bad'))} role="status">
      <span className="mono">! {t.run}</span>
      <span>{t.alive ? 'running…' : t.startError ? `could not run: ${t.startError}` : `exit ${t.exitCode}${took}`} · run by you</span>
    </div>
  )
}
