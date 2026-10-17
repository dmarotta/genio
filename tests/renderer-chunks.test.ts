/**
 * Every screen but the chat loads on first use (App.tsx), and xterm with the first terminal shown.
 * Guard: the modules a window evaluates before its first paint (static imports from main.tsx) reach
 * none of them, so one stray import cannot pull a whole screen back into the main chunk.
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'

const RENDERER = path.resolve('src/renderer/src')
const resolve = (from: string, spec: string): string | undefined => {
  const base = spec.startsWith('@/') ? path.join(RENDERER, spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : undefined
  if (!base) return undefined
  return [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find(f => fs.existsSync(f) && fs.statSync(f).isFile())
}
function eagerGraph(entry: string): Set<string> {
  const seen = new Set<string>()
  const walk = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    const text = fs.readFileSync(file, 'utf8')
    // Static imports and re-exports only; import('...') is a split point.
    for (const m of text.matchAll(/^\s*(?:import|export)\s+(?:type\s+)?[^'"`;]*?from\s+'([^']+)'|^\s*import\s+'([^']+)'/gm)) {
      if (/^\s*(?:import|export)\s+type\b/.test(m[0])) continue
      const next = resolve(file, m[1] ?? m[2])
      if (next && next.startsWith(RENDERER)) walk(next)
    }
  }
  walk(entry)
  return seen
}

it('keeps screens and xterm out of what a window loads before its first paint', () => {
  const eager = [...eagerGraph(path.join(RENDERER, 'main.tsx'))].map(f => path.relative(RENDERER, f).replace(/\\/g, '/'))
  expect(eager).toContain('views/Comms.tsx')
  expect(eager).toContain('App.tsx')
  for (const lazy of ['views/Systems.tsx', 'views/Squad.tsx', 'views/Quests.tsx', 'views/CharacterSheet.tsx', 'views/Inventory.tsx', 'views/ArtBible.tsx', 'views/Design.tsx',
    'views/Play.tsx', 'views/Hub.tsx', 'views/ProjectSettings.tsx', 'views/UnitySlots.tsx', 'components/Terminal.tsx']) expect(eager, lazy).not.toContain(lazy)
})
