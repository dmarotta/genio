import { randomBytes } from 'node:crypto'
import type { HarnessAdapter, Settings } from '@shared/types'
import type { SettingsService } from './services'
import type { Home } from './home'
import { bus } from './bus'
import { mergeHarnesses } from './harness'
import { readJson, which, writeJson } from './util'

export function defaultSettings(): Settings {
  return {
    gamertag: 'Player',
    wkspModel: '',
    wkspEffort: 'high',
    botModel: '',
    defaultHarness: 'claude',
    defaultWorkerModel: '',
    defaultWorkerEffort: '',
    claudePermissionMode: 'bypass',
    claudePath: '',
    shell: '',
    pollSeconds: 15,
    staleSeconds: 240,
    staleEscalations: 3,
    pausedResurfaceHours: 4,
    heartbeatBaseMinutes: 10,
    heartbeatMaxMinutes: 120,
    prPollMinutes: 3,
    signalGraceSeconds: 30,
    inboxGraceSeconds: 90,
    inboxRingMax: 3,
    maxRelaunches: 3,
    reviewModel: '',
    validationMaxRounds: 3,
    autoDispatchQueued: false,
    sound: true,
    soundVolume: 0.5,
    fx: true,
    calm: false,
    voice: false,
    desktopNotifications: true,
    webhookUrl: '',
    webhookKind: 'discord',
    alarmMinutes: 5,
    alarm: 'auto',
    awayBatchSeconds: 90,
    inboxServer: false,
    inboxPort: 47821,
    inboxToken: randomBytes(16).toString('hex'),
    ledger: true,
    memoryBudgetTokens: 7500,
    briefInclude: '',
    stripAiTrailers: true,
    harnesses: mergeHarnesses(undefined),
    dispatchRules: [],
    eventSources: [],
    firstRunDone: false
  }
}

export function createSettingsService(home: Home): SettingsService {
  const defaults = defaultSettings()
  const saved = readJson<Partial<Settings>>(home.settingsFile, {})
  let current: Settings = { ...defaults, ...saved, harnesses: mergeHarnesses(saved.harnesses) }
  if (!saved.inboxToken) writeJson(home.settingsFile, current)

  const svc: SettingsService = {
    get: () => current,
    save(patch) {
      const next: Settings = { ...current, ...patch }
      if (patch.harnesses) next.harnesses = mergeHarnesses(patch.harnesses)
      current = next
      writeJson(home.settingsFile, current)
      bus.publish({ type: 'settings', settings: current })
      return current
    },
    harness(id: string): HarnessAdapter | undefined {
      return current.harnesses.find((h) => h.id === id)
    },
    availableHarnesses() {
      return current.harnesses.filter((h) => h.enabled && h.verified && Boolean(which(h.command)))
    }
  }
  return svc
}
