import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Home } from '../src/main/home'
import { bus } from '../src/main/bus'
import { createSettingsService, defaultSettings } from '../src/main/settings'
import { migrateUsageSettings } from '../src/main/usage-policy'
import type { Settings } from '../src/shared/types'

let dir: string, home: Home
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-unit-limit-'))
  home = new Home(dir)
  home.ensure()
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })

describe('independent unit concurrency', () => {
  it.each([
    [{}, 8], [{ usageMode: 'save' }, 4], [{ usageMode: 'balanced' }, 8], [{ usageMode: 'max' }, 16],
    [{ costDial: 'cost' }, 4], [{ costDial: 'quality' }, 16], [{ usageMode: 'invalid', costDial: 'quality' }, 16]
  ])('migrates %j once without losing saved data', (mode, cap) => {
    const saved = { ...mode, inboxToken: 'test-token', wkspModel: 'pinned', wkspEffort: 'high', customSetting: { preserved: true } }
    fs.writeFileSync(home.settingsFile, JSON.stringify(saved))
    const publish = vi.spyOn(bus, 'publish')
    const service = createSettingsService(home)
    expect(service.get().unitsAtOnce).toBe(cap)
    expect(JSON.parse(fs.readFileSync(home.settingsFile, 'utf8'))).toMatchObject({
      ...saved, usageMode: cap === 4 ? 'save' : cap === 16 ? 'max' : 'balanced', unitsAtOnce: cap
    })
    expect(publish).not.toHaveBeenCalled()
    service.save({ usageMode: 'max' })
    service.save({ usageMode: 'save' })
    expect(service.get().unitsAtOnce).toBe(cap)
    expect(createSettingsService(home).get().unitsAtOnce).toBe(cap)
  })

  it('defaults new installs to eight, preserves an explicit limit and migrates idempotently', () => {
    expect(defaultSettings().unitsAtOnce).toBe(8)
    expect(createSettingsService(home).get().unitsAtOnce).toBe(8)
    const saved = { usageMode: 'max', unitsAtOnce: 3, wkspEffort: 'high', quotaProtection: true, plainModelDefaults: true } as Partial<Settings>
    expect(migrateUsageSettings(saved)).toBe(saved)
    expect(migrateUsageSettings({ costDial: 'quality', unitsAtOnce: 5 })).toMatchObject({ usageMode: 'max', unitsAtOnce: 5 })
  })

  it.each([[0, 1], [-2, 1], [33, 32], [3.7, 4], [null, 16], ['bad', 16]])('normalizes saved limit %j to %i', (value, expected) => {
    expect(migrateUsageSettings({ usageMode: 'max', unitsAtOnce: value } as Partial<Settings>).unitsAtOnce).toBe(expected)
  })

  it('persists explicit changes and emits the achievement event only for a successful change', () => {
    const service = createSettingsService(home)
    const publish = vi.spyOn(bus, 'publish')
    service.save({ unitsAtOnce: 3 })
    expect(service.get()).toMatchObject({ unitsAtOnce: 3, usageMode: 'balanced' })
    expect(createSettingsService(home).get().unitsAtOnce).toBe(3)
    expect(publish.mock.calls.filter(([event]) => event.type === 'feature-used')).toEqual([
      [{ type: 'feature-used', feature: 'units-at-once' }]
    ])
    publish.mockClear()
    service.save({ unitsAtOnce: 3, usageMode: 'max' })
    service.save({ sound: false })
    expect(publish.mock.calls.some(([event]) => event.type === 'feature-used')).toBe(false)
    service.save({ unitsAtOnce: 0 })
    expect(service.get().unitsAtOnce).toBe(1)
    service.save({ unitsAtOnce: 100 })
    expect(service.get().unitsAtOnce).toBe(32)
  })
})
