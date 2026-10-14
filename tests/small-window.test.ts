import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'
import { WINDOW_MIN } from '../src/shared/window'

const root = join(__dirname, '..', 'src', 'renderer')
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []))
const rail = Number(/--rail:\s*(\d+)px/.exec(readFileSync(join(root, 'src', 'styles', 'theme.css'), 'utf8'))?.[1])
// The stage beside the rail in the smallest project window.
const stage = WINDOW_MIN.width - rail

it('keeps the window minimum small enough to resize down to a quarter of a laptop screen', () => {
  expect(WINDOW_MIN.width).toBeLessThanOrEqual(480)
  expect(WINDOW_MIN.height).toBeLessThanOrEqual(360)
  expect(rail).toBeGreaterThan(0)
})

it('never sets a fixed minimum width or grid track wider than the smallest stage', () => {
  // A bare px minimum wider than the stage forces horizontal scrolling; wrap it as min(<px>, 100%) instead.
  const hits = files(root).flatMap((f) => readFileSync(f, 'utf8').split('\n').flatMap((line, i) =>
    [...line.matchAll(/(?<![\w-])min-width:\s*(\d+)px|minmax\((\d+)px/g)]
      .filter((m) => Number(m[1] ?? m[2]) > stage)
      .map((m) => `${relative(root, f)}:${i + 1} ${m[0]}`)))
  expect(hits).toEqual([])
})
