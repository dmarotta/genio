import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('keeps the queue link in its area and removes the sheet shortcut below the composer', () => {
  const source = readFileSync('src/renderer/src/views/Comms.tsx', 'utf8')
  expect(source).toContain('{!isAlly && <ComingNext />}')
  const hints = source.slice(source.indexOf('<div className="composer-hints mute">'), source.indexOf('const SHELL_MODES'))
  expect(hints).toContain('Recap')
  expect(hints).toContain('Deploy')
  expect(hints).not.toContain('Character Sheet')
  expect(hints).not.toContain("go('status')")
})

