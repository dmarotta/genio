import { useEffect, type ComponentType } from 'react'
import { registerViews, useStore, type ViewId } from './store'
import { TitleBar } from './components/TitleBar'
import { Rail } from './components/Rail'
import { AchievementOverlay, BootSplash, PermissionPrompt, Toasts, WelcomeBack } from './components/Overlays'
import { CommandPalette, useGlobalKeys } from './components/CommandPalette'
import { DeployModal } from './components/DeployModal'
import { Onboarding } from './components/Onboarding'
import { Comms } from './views/Comms'
import { Squad } from './views/Squad'
import { Quests } from './views/Quests'
import { YourMove } from './views/YourMove'
import { CharacterSheet } from './views/CharacterSheet'
import { ProjectNotice, Worlds } from './views/Worlds'
import { Lore } from './views/Lore'
import { Systems } from './views/Systems'
import { Inventory } from './views/Inventory'
import { Play } from './views/Play'

const VIEW: Partial<Record<ViewId, ComponentType>> = {
  play: Play,
  comms: Comms,
  squad: Squad,
  quests: Quests,
  move: YourMove,
  status: CharacterSheet,
  worlds: Worlds,
  lore: Lore,
  systems: Systems,
  inventory: Inventory
}

registerViews(Object.keys(VIEW))

export function App() {
  const booted = useStore((s) => s.booted)
  const connected = useStore((s) => s.connected)
  const view = useStore((s) => s.view)
  const fx = useStore((s) => s.settings?.fx)
  useGlobalKeys()

  useEffect(() => {
    document.body.classList.toggle('fx-off', fx === false)
  }, [fx])

  const View = VIEW[view] ?? Worlds
  return (
    <div className="app">
      <TitleBar />
      <ProjectNotice />
      <div className="app-body">
        <Rail />
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
      </div>
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
