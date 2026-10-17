import { Suspense, lazy, useEffect, type ComponentType } from 'react'
import { FolderOpen, Settings as SettingsIcon } from 'lucide-react'
import { PROJECT_WINDOW, go, setState, toggleAnswers, registerViews, useStore, type ViewId } from './store'
import { cx } from './lib/format'
import { TitleBar } from './components/TitleBar'
import { FileMenu } from './components/FileMenu'
import { Rail } from './components/Rail'
import { AchievementOverlay, BootSplash, PermissionPrompt, Toasts, WelcomeBack } from './components/Overlays'
import { CommandPalette, useGlobalKeys } from './components/CommandPalette'
import { DeployModal } from './components/DeployModal'
import { Onboarding } from './components/Onboarding'
import { Comms } from './views/Comms'
import { Answers } from './components/Answers'
import { ProjectNotice } from './components/ProjectNotice'
import { GenioPanel } from './components/GenioPanel'
import { TerminalPane, preloadPaneTerminal } from './components/TerminalPane'

/**
 * Every screen but the chat is its own chunk, loaded on first use: the window shell and chat paint without
 * parsing Settings, Squad or Inventory first. Once booted, the rest load while the window is idle, so a
 * first visit usually renders at once; until then the stage shows its empty shell.
 */
const SCREENS = {
  play: () => import('./views/Play').then(m => m.Play),
  squad: () => import('./views/Squad').then(m => m.Squad),
  quests: () => import('./views/Quests').then(m => m.Quests),
  status: () => import('./views/CharacterSheet').then(m => m.CharacterSheet),
  systems: () => import('./views/Systems').then(m => m.Systems),
  inventory: () => import('./views/Inventory').then(m => m.Inventory),
  'art-bible': () => import('./views/ArtBible').then(m => m.ArtBible),
  design: () => import('./views/Design').then(m => m.Design),
  hub: () => import('./views/Hub').then(m => m.Hub)
} satisfies Record<string, () => Promise<ComponentType>>
type ScreenId = keyof typeof SCREENS
const loading = new Map<ScreenId, Promise<ComponentType>>()
const loaded = new Map<ScreenId, ComponentType>()
const load = (id: ScreenId): Promise<ComponentType> => {
  let p = loading.get(id)
  if (!p) {
    p = SCREENS[id]().then(c => { loaded.set(id, c); return c })
    loading.set(id, p)
    p.catch(() => loading.delete(id))
  }
  return p
}
/** Load screens ahead of their first visit (all by default). */
export function preloadScreens(ids = Object.keys(SCREENS) as ScreenId[]): Promise<unknown> {
  return Promise.all(ids.map(load))
}
function screen(id: ScreenId): ComponentType {
  const Lazy = lazy(() => load(id).then(c => ({ default: c })))
  return function Screen() {
    const Loaded = loaded.get(id)
    return Loaded ? <Loaded /> : <Lazy />
  }
}
// The stage's empty shell while a screen's code arrives: no text, nothing to read.
const LOADING = <div className="view" data-loading="" />

const Hub = screen('hub')
const Systems = screen('systems')
const VIEW: Partial<Record<ViewId, ComponentType>> = {
  play: screen('play'),
  comms: Comms,
  squad: screen('squad'),
  quests: screen('quests'),
  design: screen('design'),
  status: screen('status'),
  systems: Systems,
  inventory: screen('inventory'),
  'art-bible': screen('art-bible')
}

registerViews(Object.keys(VIEW))

export function App() {
  const booted = useStore((s) => s.booted)
  const connected = useStore((s) => s.connected)
  const view = useStore((s) => s.view)
  const hubChoices = useStore(s => s.snap.decisions.length)
  const fx = useStore((s) => s.settings?.fx)
  useGlobalKeys(!!PROJECT_WINDOW)

  useEffect(() => {
    document.body.classList.toggle('fx-off', fx === false)
  }, [fx])

  // The Hub offers only its project list and Settings; a project window offers every screen.
  useEffect(() => {
    if (!booted) return
    const ids: ScreenId[] | undefined = PROJECT_WINDOW ? undefined : ['hub', 'systems']
    const idle = window.requestIdleCallback ?? ((run: () => void, _options?: IdleRequestOptions) => window.setTimeout(run, 200))
    idle(() => void Promise.all([preloadScreens(ids), PROJECT_WINDOW && preloadPaneTerminal()]).catch(() => undefined), { timeout: 3000 })
  }, [booted])

  // The Hub has Settings too (Genio and Advanced pages only): accounts, keys and updates need no open project.
  const hubSettings = view === 'systems'
  if (!PROJECT_WINDOW) return (
    <div className="app hub-app">
      <header className="titlebar hub-titlebar">
        <FileMenu />
        <button className={cx('btn sm ghost hub-settings-btn', hubSettings && 'on')} aria-pressed={hubSettings} title="Settings (Ctrl+,)" onClick={() => (hubSettings ? setState({ view: 'worlds' }) : go('systems'))}>
          {hubSettings ? <><FolderOpen size={13} /> Projects</> : <><SettingsIcon size={13} /> Settings</>}
        </button>
        <span className="wordmark-text">GENIO</span><span className="label dim">Hub</span>{hubChoices > 0 && <button className="btn sm ghost" onClick={toggleAnswers}>Pending answers and history</button>}
      </header>
      <div className="app-body"><main className="stage" key={hubSettings ? 'systems' : 'hub'}><Suspense fallback={LOADING}>{hubSettings ? <Systems /> : <Hub />}</Suspense></main></div>
      <Answers />
      <Toasts />
      <BootSplash ready={booted} />
    </div>
  )

  const View = VIEW[view] ?? Systems
  return (
    <div className="app">
      <TitleBar />
      <ProjectNotice />
      <div className="app-body">
        <Rail />
        {/* The terminal pane slides up under the stage; the floating chat stays within the stage above it. */}
        <div className="stage-column">
          <div className="stage-shell">
            <main className="stage" key={view}>
              {booted && !connected ? (
                <div className="offline">
                  <div className="title">
                    No <span className="accent">link</span>
                  </div>
                  <p className="dim">Genio's core is not responding. Restart the app; if it persists, check the console.</p>
                </div>
              ) : (
                <Suspense fallback={LOADING}><View /></Suspense>
              )}
            </main>
            <GenioPanel />
          </div>
          <TerminalPane />
        </div>
      </div>
      {/* Floating cards: overlaid on the right edge, outside the layout so they never reflow it. */}
      <Answers />
      <DeployModal />
      <CommandPalette />
      <WelcomeBack />
      <Onboarding />
      <PermissionPrompt />
      <AchievementOverlay />
      <Toasts />
      <BootSplash ready={booted} />
    </div>
  )
}
