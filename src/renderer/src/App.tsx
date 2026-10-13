import { useEffect, type ComponentType } from 'react'
import { useStore, type ViewId } from './store'
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
import { Status } from './views/Status'
import { Worlds } from './views/Worlds'
import { Lore } from './views/Lore'
import { Systems } from './views/Systems'
import { Fal } from './views/Fal'
import { Animation } from './views/Animation'

const VIEW: Record<ViewId, ComponentType> = {
  comms: Comms,
  squad: Squad,
  quests: Quests,
  move: YourMove,
  status: Status,
  worlds: Worlds,
  lore: Lore,
  systems: Systems,
  fal: Fal,
  animation: Animation
}

export function App() {
  const booted = useStore((s) => s.booted)
  const connected = useStore((s) => s.connected)
  const view = useStore((s) => s.view)
  const fx = useStore((s) => s.settings?.fx)
  useGlobalKeys()

  useEffect(() => {
    document.body.classList.toggle('fx-off', fx === false)
  }, [fx])

  const View = VIEW[view]
  return (
    <div className="app">
      <TitleBar />
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
