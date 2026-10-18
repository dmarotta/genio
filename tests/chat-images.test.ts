import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE, base64Bytes, chatImageUrl, fitWithin, planImage, shrinkStep, userContent, validChatImageFile,
  type ChatImageInput
} from '@shared/chat-images'
import type { ChatMessage } from '@shared/types'
import { chatImageDir, chatImagePath, saveChatImages } from '../src/main/chat-images'
import { userMessage } from '../src/main/workspace'
import { appendJsonl, readJsonl } from '../src/main/util'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')
const png = (extra: Partial<ChatImageInput> = {}): ChatImageInput => ({ mediaType: 'image/png', data: PNG, width: 4, height: 2, ...extra })

describe('message building', () => {
  it('keeps text-only turns as a plain string', () => {
    expect(userContent('hello')).toBe('hello')
    expect(userContent('hello', [])).toBe('hello')
  })

  it('sends images as base64 image blocks before the text', () => {
    const content = userContent('what is wrong here?', [png(), { mediaType: 'image/jpeg', data: 'abcd' }])
    expect(content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'abcd' } },
      { type: 'text', text: 'what is wrong here?' }
    ])
  })

  it('allows images without text', () => {
    expect(userContent('  ', [png()])).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }])
  })

  it('wraps the content in an SDK user message', () => {
    const m = userMessage('look', [png()]) as unknown as { type: string; message: { role: string; content: unknown[] } }
    expect(m.type).toBe('user')
    expect(m.message.role).toBe('user')
    expect(m.message.content).toHaveLength(2)
    expect((userMessage('plain') as unknown as { message: { content: unknown } }).message.content).toBe('plain')
  })
})

describe('downscale sizing', () => {
  it('caps the long edge at 2000px keeping aspect', () => {
    expect(fitWithin(4000, 2000)).toEqual({ width: 2000, height: 1000 })
    expect(fitWithin(1080, 3840)).toEqual({ width: 563, height: 2000 })
    expect(fitWithin(1920, 1080)).toEqual({ width: 1920, height: 1080 })
  })

  it('sends small accepted images untouched', () => {
    expect(planImage('image/png', 200_000, 1920, 1080)).toEqual({ width: 1920, height: 1080, reencode: false, outType: 'image/png' })
    expect(planImage('image/gif', 50_000, 300, 300).reencode).toBe(false)
  })

  it('re-encodes oversized, too-heavy or unsupported images', () => {
    expect(planImage('image/png', 1_000, 5120, 2880)).toEqual({ width: 2000, height: 1125, reencode: true, outType: 'image/png' })
    expect(planImage('image/jpeg', MAX_IMAGE_BYTES + 1, 1000, 1000)).toMatchObject({ reencode: true, outType: 'image/jpeg' })
    expect(planImage('image/bmp', 1_000, 10, 10)).toMatchObject({ reencode: true, outType: 'image/png' })
    expect(planImage('image/gif', 1_000, 3000, 100)).toMatchObject({ reencode: true, outType: 'image/png' })
  })

  it('shrinks step by step and keeps the byte cap under the API limit once base64-encoded', () => {
    expect(shrinkStep(2000, 1000)).toEqual({ width: 1500, height: 750 })
    expect(Math.ceil(MAX_IMAGE_BYTES / 3) * 4).toBeLessThanOrEqual(5 * 1024 * 1024)
    expect(base64Bytes(PNG)).toBe(16)
  })
})

describe('history', () => {
  const dirs: string[] = []
  const tmp = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-chatimg-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  it('stores images in Genio data and references them from the message across a reload', () => {
    const data = tmp()
    const dir = chatImageDir(data)
    const { refs, send } = saveChatImages(dir, [png(), { mediaType: 'image/webp', data: PNG }])
    expect(refs).toHaveLength(2)
    expect(refs[0]).toMatchObject({ mediaType: 'image/png', width: 4, height: 2 })
    expect(refs[0].file).toMatch(/\.png$/)
    expect(refs[1].file).toMatch(/\.webp$/)
    expect(send[0]).toEqual(png())
    for (const r of refs) expect(fs.readFileSync(chatImagePath(dir, r.file)!).toString('base64')).toBe(PNG)

    const chat = path.join(data, 'chat.jsonl')
    const m: ChatMessage = { id: 'p-1', workspace: 'main', role: 'player', text: '', ts: '2026-10-13T10:00:00Z', images: refs }
    appendJsonl(chat, m)
    const [back] = readJsonl<ChatMessage>(chat)
    expect(back).toEqual(m)
    expect(chatImageUrl('main', back.images![0].file)).toBe(`genio-media://chat/main/${back.images![0].file}`)
  })

  it('rejects bad inputs and unsafe file names', () => {
    const dir = chatImageDir(tmp())
    expect(() => saveChatImages(dir, [{ mediaType: 'image/bmp' as 'image/png', data: PNG }])).toThrow(/Unsupported/)
    expect(() => saveChatImages(dir, [png({ data: '' })])).toThrow(/empty/)
    expect(() => saveChatImages(dir, Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => png()))).toThrow(/At most/)
    expect(saveChatImages(dir, [])).toEqual({ refs: [], send: [] })
    expect(validChatImageFile('../chat.jsonl')).toBe(false)
    expect(validChatImageFile('abc-12.exe')).toBe(false)
    expect(chatImagePath(dir, '..\\..\\x.png')).toBeUndefined()
    expect(chatImagePath(dir, 'missing-1.png')).toBeUndefined()
  })
})
