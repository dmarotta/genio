import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('keeps no queue link and no sheet, Recap or Deploy shortcut in the chat', () => {
  const source = readFileSync('src/renderer/src/views/Comms.tsx', 'utf8')
  expect(source).not.toContain('ComingNext')
  const hints = source.slice(source.indexOf('<div className="composer-hints mute">'), source.indexOf('const SHELL_MODES'))
  expect(hints).not.toContain('Recap')
  expect(hints).not.toContain('Deploy')
  expect(source).not.toContain('Character Sheet')
  expect(source).not.toContain("go('status')")
})