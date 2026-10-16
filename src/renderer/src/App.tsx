import { useEffect, type ComponentType } from 'react'
import { FolderOpen, Settings as SettingsIcon } from 'lucide-react'
import { PROJECT_WINDOW, go, setState, toggleAnswers, registerViews, useStore, type ViewId } from './store'
import { cx } from './lib/format'
import { Hub } from './views/Hub'
import { TitleBar } from './components/TitleBar'
import { FileMenu } from './components/FileMenu'
import { Rail } from './components/Rail'
import { AchievementOverlay, BootSplash, PermissionPrompt, Toasts, WelcomeBack } from './components/Overlays'
import { CommandPalette, useGlobalKeys } from './components/CommandPalette'
import { DeployModal } from './components/DeployModal'
import { Onboarding } from './components/Onboarding'
import { Comms } from './views/Comms'
import { Squad } from './views/Squad'
import { Quests } from './views/Quests'
import { Answers } from './components/Answers'
import { CharacterSheet } from './views/CharacterSheet'
import { ProjectNotice } from './views/ProjectSettings'
import { Systems } from './views/Systems'
import { Inventory } from './views/Inventory'
import { Play } from './views/Play'
import { GenioPanel } from './components/GenioPanel'
import { TerminalPane } from './components/TerminalPane'

const VIEW: Partial<Record<ViewId, ComponentType>> = {
  play: Play,
  comms: Comms,
  squad: Squad,
  quests: Quests,
  status: CharacterSheet,
  systems: Systems,
  inventory: Inventory
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
      <div className="app-body"><main className="stage" key={hubSettings ? 'systems' : 'hub'}>{hubSettings ? <Systems /> : <Hub />}</main></div>
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
                <View />
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
