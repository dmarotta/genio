import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Home } from '../src/main/home'
import { inheritMainHistory, allyNameForWorld } from '../src/main/project-chat'
import { readJsonl } from '../src/main/util'
import type { ChatMessage } from '../src/shared/types'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
it('imports the legacy conversation and images once without altering its archive or existing project messages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-project-chat-')); roots.push(root)
  const source = new Home(root); source.ensure()
  const target = new Home(path.join(root, 'workspaces', 'genio'), 'genio', source); target.ensure()
  const old = [{ id: 'old', wksp: 'main', role: 'player', text: 'draft sent', queue: 'queued', ts: '2026-01-01' },
    { id: 'shared', wksp: 'main', role: 'genio', text: 'old reply', ts: '2026-01-02' }]
  fs.writeFileSync(source.chatFile, old.map(m => JSON.stringify(m)).join('\n'))
  fs.writeFileSync(target.chatFile, JSON.stringify({ ...old[1], wksp: 'genio', text: 'new reply' }) + '\n')
  fs.mkdirSync(path.join(source.data, 'chat-images')); fs.writeFileSync(path.join(source.data, 'chat-images', 'image.png'), 'image bytes')
  const archive = fs.readFileSync(source.chatFile)
  inheritMainHistory(source, target)
  expect(readJsonl<ChatMessage>(target.chatFile)).toMatchObject([
    { id: 'old', wksp: 'genio', queue: 'unsent' }, { id: 'shared', text: 'new reply' }
  ])
  expect(fs.readFileSync(path.join(target.data, 'chat-images', 'image.png'), 'utf8')).toBe('image bytes')
  const imported = fs.readFileSync(target.chatFile)
  inheritMainHistory(source, target)
  expect(fs.readFileSync(target.chatFile)).toEqual(imported)
  expect(fs.readFileSync(source.chatFile)).toEqual(archive)
  expect(fs.existsSync(target.wkspFile)).toBe(false)
})
it('keeps project chat names valid, including the reserved main name', () => {
  expect(allyNameForWorld('Main')).toBe('main-world')
  expect(allyNameForWorld('My Game!')).toBe('my-game')
  expect(allyNameForWorld('x')).toBe('world-x')
})
