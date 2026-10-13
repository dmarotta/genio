import fs from 'node:fs'
import path from 'node:path'
import type { ChatMessage } from '@shared/types'
import type { AllyCreateRequest } from '@shared/api'
import { compactChat } from '@shared/chat'
import type { Home } from './home'
import { readJsonl, writeText } from './util'

export function allyNameForWorld(world: string): string {
  let name = world.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+/, '').slice(0, 31).replace(/-+$/, '')
  if (name === 'main') name = 'main-world'
  return name.length < 2 ? `world-${name || 'ally'}` : name
}

export function worldAllyRequest(world: string): AllyCreateRequest {
  return { name: allyNameForWorld(world), scope: `All work in ${world}`, charter: '', projects: [world] }
}

/** Copy the legacy log once, without changing it or adopting a cross-world provider session.
 * Existing project messages win on id. Write the marker last so interrupted imports can retry.
 */
export function inheritMainHistory(source: Home, target: Home): void {
  const marker = path.join(target.state, 'main-history-imported.json')
  if (fs.existsSync(marker)) return
  const old = compactChat(readJsonl<ChatMessage>(source.chatFile)).map(message => ({
    ...message, wksp: target.name, ...(message.queue === 'queued' ? { queue: 'unsent' as const } : {})
  }))
  const messages = new Map(old.map(message => [message.id, message]))
  for (const message of compactChat(readJsonl<ChatMessage>(target.chatFile))) messages.set(message.id, message)
  const images = path.join(source.data, 'chat-images')
  if (fs.existsSync(images)) fs.cpSync(images, path.join(target.data, 'chat-images'), { recursive: true, force: false })
  writeText(target.chatFile, [...messages.values()].sort((a, b) => a.ts.localeCompare(b.ts)).map(m => JSON.stringify(m)).join('\n') + '\n')
  writeText(marker, JSON.stringify({ source: source.chatFile }))
}
