import { randomBytes } from 'node:crypto'
import type { HarnessAdapter, Settings } from '@shared/types'
import type { SettingsService } from './services'
import type { Home } from './home'
import { bus } from './bus'
import { mergeHarnesses } from './harness'
import { normalizeCategoryPools } from '@shared/dispatch'
import { readJson, which, writeJson } from './util'
import { migrateUsageSettings } from './usage-policy'
import { DEFAULT_USAGE_MODE } from '@shared/usage-mode'
import { DEFAULT_UNITS_AT_ONCE, normalizeUnitsAtOnce } from '@shared/unit-capacity'
import { DEFAULT_REPLY_VOICE } from '@shared/reply-voice'

export function defaultSettings(): Settings {
  return {
    gamertag: 'Player',
    wkspModel: '',
    wkspEffort: '',
    botModel: '',
    defaultHarness: '',
    defaultWorkerModel: '',
    defaultWorkerEffort: '',
    claudePermissionMode: 'bypass',
    chatShellMode: 'ask',
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
    maxRelaunches: 1,
    reviewModel: '',
    validationMaxRounds: 3,
    autoDispatchQueued: false,
    sound: true,
    soundVolume: 0.5,
    fx: true,
    calm: false,
    voice: false,
    replyVoice: DEFAULT_REPLY_VOICE,
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
    genioCoAuthor: true,
    genioCoAuthorIdentity: 'Genio <noreply@genio.invalid>',
    harnesses: mergeHarnesses(undefined),
    dispatchRules: [],
    categoryPools: [],
    costDial: 'balanced',
    explorationRate: 0,
    usageMode: DEFAULT_USAGE_MODE,
    unitsAtOnce: DEFAULT_UNITS_AT_ONCE,
    quotaProtection: true,
    cheapSpendAllowed: false,
    plainModelDefaults: true,
    eventSources: [],
    firstRunDone: false,
    featureTips: true
  }
}

export function createSettingsService(home: Home): SettingsService {
  const defaults = defaultSettings()
  const stored = readJson<Partial<Settings>>(home.settingsFile, {})
  const saved = migrateUsageSettings(stored)
  let current: Settings = { ...defaults, ...saved, harnesses: mergeHarnesses(saved.harnesses), categoryPools: normalizeCategoryPools(saved.categoryPools) }
  if (!saved.inboxToken || saved !== stored) writeJson(home.settingsFile, current)

  const svc: SettingsService = {
    get: () => current,
    save(patch) {
      const next: Settings = { ...current, ...patch, unitsAtOnce: normalizeUnitsAtOnce(patch.unitsAtOnce, current.unitsAtOnce) }
      if (patch.harnesses) next.harnesses = mergeHarnesses(patch.harnesses)
      if (patch.categoryPools) next.categoryPools = normalizeCategoryPools(patch.categoryPools)
      const enteredYolo = current.chatShellMode !== 'all' && next.chatShellMode === 'all'
      const changedUnitsAtOnce = next.unitsAtOnce !== current.unitsAtOnce
      const changedProtection = current.quotaProtection !== next.quotaProtection
      writeJson(home.settingsFile, next)
      current = next
      if (changedProtection) bus.publish({ type: 'feature-used', feature: 'quota-protection' })
      if (changedUnitsAtOnce) bus.publish({ type: 'feature-used', feature: 'units-at-once' })
      if (enteredYolo) bus.publish({ type: 'feature-used', feature: 'yolo-chat' })
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
