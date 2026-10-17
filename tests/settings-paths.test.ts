import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SETTINGS_ALIASES, SETTINGS_PAGES, SETTINGS_PARTS, settingsPath } from '../src/shared/settings-pages'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
/** Where text names a place in Settings: app code, what units read, and the docs. */
const SCAN: { dir: string; ext: RegExp; deep: boolean }[] = [
  { dir: 'src', ext: /\.(ts|tsx|mjs)$/, deep: true },
  { dir: 'resources/unit-skills', ext: /\.(md|mjs|ts)$/, deep: true },
  { dir: 'docs', ext: /\.md$/, deep: false },
  { dir: '.', ext: /^README\.md$/, deep: false }
]

function files(dir: string, ext: RegExp, deep: boolean): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) return deep && e.name !== 'node_modules' ? files(rel, ext, deep) : []
    return ext.test(e.name) ? [rel] : []
  })
}

/** "Settings › X", "Settings -> X", "Settings > X" all read as "Settings → X"; markdown bold is dropped. */
const normalise = (s: string): string => s.replace(/\*\*/g, '').replace(/\s*(→|›|->|>)\s*/g, ' → ')

/** Every path settingsPath() can produce: each page, each part a retired id became, and the two group heads. */
const VALID = [
  ...SETTINGS_PAGES.map((p) => settingsPath(p.id)),
  ...Object.keys(SETTINGS_ALIASES).map((id) => settingsPath(id)),
  'Settings → This project',
  'Settings → Advanced'
].sort((a, b) => b.length - a.length)

function settingsMentions(): { at: string; text: string }[] {
  const out: { at: string; text: string }[] = []
  for (const { dir, ext, deep } of SCAN) {
    for (const file of files(dir, ext, deep)) {
      fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').forEach((line, i) => {
        // A capital (or quote/bold) after the arrow: a path, not TypeScript such as Partial<Settings> = {}.
        for (const m of line.matchAll(/\bSettings\s*(?:→|›|->|>)\s*(?=[A-Z"*])/g)) {
          out.push({ at: `${file.replace(/\\/g, '/')}:${i + 1}`, text: normalise(line.slice(m.index)) })
        }
      })
    }
  }
  return out
}

describe('Settings paths in text', () => {
  it('name the game term as a hint and parts that retired pages became', () => {
    expect(settingsPath('gauntlet')).toBe('Settings → This project → Delivery')
    expect(settingsPath('maintenance')).toBe("Settings → System → Genio's past sessions")
    expect(settingsPath('harnesses')).toBe('Settings → Advanced → Agent tools (Harnesses)')
    expect(settingsPath('toolchain')).toBe('Settings → System → Installed tools (Loadout)')
    expect(settingsPath('patch')).toBe('Settings → System → Updates (Patch)')
    expect(settingsPath('accounts', 'API keys')).toBe('Settings → Accounts & keys → API keys')
    for (const part of Object.values(SETTINGS_PARTS)) expect(part.label).not.toMatch(/\(/)
  })

  it('every "Settings > X" string in the source, unit skills and docs resolves to a real page', () => {
    const mentions = settingsMentions()
    expect(mentions.length).toBeGreaterThan(20)
    const broken = mentions.filter(({ text }) => !VALID.some((v) => text.startsWith(v) && !/[A-Za-z0-9]/.test(text[v.length] ?? '')))
    expect(broken.map((b) => `${b.at}  ${b.text.slice(0, 90)}`), `use settingsPath(); valid paths:\n${VALID.join('\n')}`).toEqual([])
  })
})
