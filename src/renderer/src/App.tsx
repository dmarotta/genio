import { useEffect, type ComponentType } from 'react'
import { PROJECT_WINDOW, toggleAnswers, registerViews, useStore, type ViewId } from './store'
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
import { GenioPanel } from './components/GenioPanel'

const VIEW: Partial<Record<ViewId, ComponentType>> = {
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

  if (!PROJECT_WINDOW) return (
    <div className="app hub-app">
      <header className="titlebar hub-titlebar"><FileMenu /><span className="wordmark-text">GENIO</span><span className="label dim">Hub</span>{hubChoices > 0 && <button className="btn sm ghost" onClick={toggleAnswers}>Pending answers and history</button>}</header>
      <div className="app-body"><main className="stage"><Hub /></main></div>
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
