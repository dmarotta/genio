import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { saveChatImages } from '../src/main/chat-images'
import {
  MAX_GENERATED, attachedIdsNote, friendlyError, generateChatImages, generateImageShape, pngSize, resolveRefs, type ChatImageGen
} from '../src/main/chat-imagegen'
import { codexImageSkillDir, unitPluginSource } from '../src/main/unitskills'
import type { ChatMessage } from '@shared/types'

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = path.join(codexImageSkillDir(unitPluginSource(APP_ROOT)), 'scripts', 'codex-image.mjs')
const FAKE = path.join(APP_ROOT, 'tests', 'fixtures', 'fake-codex.mjs')
const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const args = z.object(generateImageShape)

let tmp: string
let codexHome: string
let posts: { m: ChatMessage; persist: boolean }[]
let gen: ChatImageGen

const make = (env: Record<string, string | undefined> = {}): ChatImageGen => ({
  chatDir: path.join(tmp, 'data', 'chat-images'),
  wksp: 'main',
  post: (m, persist) => void posts.push({ m, persist }),
  run: { script: SCRIPT, scratch: path.join(tmp, 'data', 'codex-image'), env: { GENIO_CODEX_BIN: FAKE, CODEX_HOME: codexHome, FAKE_CODEX_MODE: undefined, FAKE_CODEX_USED: undefined, ...env } }
})

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-imagegen-'))
  codexHome = path.join(tmp, 'codex')
  fs.mkdirSync(codexHome)
  posts = []
  gen = make()
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const call = (): { args: string[]; prompt: string } => JSON.parse(fs.readFileSync(path.join(codexHome, 'fake-args.json'), 'utf8'))

describe('generate_image arguments', () => {
  it('defaults count to 1 and transparent to false', () => {
    expect(args.parse({ prompt: 'a red gem' })).toEqual({ prompt: 'a red gem', transparent: false, refs: [], count: 1 })
  })

  it('rejects an empty prompt, counts outside 1-4 and too many refs', () => {
    expect(args.safeParse({ prompt: '' }).success).toBe(false)
    expect(args.safeParse({ prompt: 'gem', count: 0 }).success).toBe(false)
    expect(args.safeParse({ prompt: 'gem', count: MAX_GENERATED + 1 }).success).toBe(false)
    expect(args.safeParse({ prompt: 'gem', count: 1.5 }).success).toBe(false)
    expect(args.safeParse({ prompt: 'gem', refs: Array.from({ length: 9 }, () => 'a.png') }).success).toBe(false)
    expect(args.safeParse({ prompt: 'gem', count: 4, transparent: true, refs: ['x.png'] }).success).toBe(true)
  })
})

describe('refs', () => {
  it('resolves chat image ids of this chat and absolute image paths', () => {
    const { refs } = saveChatImages(gen.chatDir, [{ mediaType: 'image/png', data: PNG1 }])
    const abs = path.join(tmp, 'ref.png')
    fs.writeFileSync(abs, Buffer.from(PNG1, 'base64'))
    expect(resolveRefs(gen.chatDir, [refs[0].file, abs])).toEqual([path.join(gen.chatDir, refs[0].file), abs])
  })

  it('refuses unknown ids, relative paths and non-images', () => {
    expect(() => resolveRefs(gen.chatDir, ['missing-1.png'])).toThrow(/No chat image/)
    expect(() => resolveRefs(gen.chatDir, ['../chat.jsonl'])).toThrow(/neither a chat image id/)
    expect(() => resolveRefs(gen.chatDir, [path.join(tmp, 'notes.txt')])).toThrow(/PNG, JPEG/)
    expect(() => resolveRefs(gen.chatDir, [path.join(tmp, 'nope.png')])).toThrow(/not found/)
  })

  it('names pasted images in the prompt so they can be passed as refs', () => {
    expect(attachedIdsNote([])).toBe('')
    expect(attachedIdsNote([{ file: 'a-1.png', mediaType: 'image/png' }, { file: 'b-2.jpg', mediaType: 'image/jpeg' }])).toBe('\n\n[attached image ids: a-1.png, b-2.jpg]')
  })
})

describe('generate_image in the chat', () => {
  it('posts a placeholder, then the images as chat images, and returns them to the model', async () => {
    const r = await generateChatImages(gen, args.parse({ prompt: 'a red gem', count: 2, transparent: true }))
    expect(r.isError).toBeFalsy()

    // placeholder first (on screen only), then the same message resolved and persisted
    expect(posts).toHaveLength(2)
    const [ph, done] = posts
    expect(ph.persist).toBe(false)
    expect(ph.m).toMatchObject({ wksp: 'main', role: 'genio', generating: 2 })
    expect(ph.m.text).toMatch(/Generating 2 images/)
    expect(done.persist).toBe(true)
    expect(done.m.id).toBe(ph.m.id)
    expect(done.m.generating).toBeUndefined()
    expect(done.m.text).toMatch(/Generated 2 images\*\* · transparent/)
    expect(done.m.text).toContain('> revised: a red gem')
    expect(done.m.text).not.toMatch(/plan meter/)
    expect(done.m.images).toHaveLength(2)
    for (const img of done.m.images!) {
      expect(img).toMatchObject({ mediaType: 'image/png', width: 1, height: 1 })
      expect(fs.readFileSync(path.join(gen.chatDir, img.file)).toString('base64')).toBe(PNG1)
    }

    // one Codex run outside any world, scratch under Genio's data
    const c = call()
    expect(c.prompt).toMatch(/Item 1 \(transparent background: yes\):\na red gem/)
    expect(c.prompt).toMatch(/Item 2 \(transparent background: yes\):\na red gem/)
    expect(fs.readdirSync(gen.run.scratch)).toHaveLength(1)

    const [text, ...imgs] = r.content as { type: string; text?: string; data?: string; mimeType?: string }[]
    const summary = JSON.parse(text.text!)
    expect(summary).toMatchObject({ posted_in_chat: true, plan_meter_percent: 5 })
    expect(summary.images.map((i: { id: string }) => i.id)).toEqual(done.m.images!.map((i) => i.file))
    expect(imgs).toEqual([
      { type: 'image', data: PNG1, mimeType: 'image/png' },
      { type: 'image', data: PNG1, mimeType: 'image/png' }
    ])
  })

  it('passes earlier chat images as refs for an edit', async () => {
    const first = await generateChatImages(gen, args.parse({ prompt: 'a knight' }))
    const id = JSON.parse((first.content[0] as { text: string }).text).images[0].id
    const pasted = saveChatImages(gen.chatDir, [{ mediaType: 'image/png', data: PNG1 }]).refs[0].file
    const r = await generateChatImages(gen, args.parse({ prompt: 'same knight, blue armour', refs: [id, pasted] }))
    expect(r.isError).toBeFalsy()
    const a = call().args
    expect(a.filter((x) => x === '-i')).toHaveLength(2)
    expect(a).toEqual(expect.arrayContaining([path.join(gen.chatDir, id), path.join(gen.chatDir, pasted)]))
    expect(posts.at(-1)!.m.text).toMatch(/from 2 references/)
  })

  it('warns in the message when the plan meter is high', async () => {
    const r = await generateChatImages(make({ FAKE_CODEX_USED: '85' }), args.parse({ prompt: 'a gem' }))
    expect(JSON.parse((r.content[0] as { text: string }).text)).toMatchObject({ plan_meter_percent: 85, warning: 'ChatGPT plan meter at 85%' })
    expect(posts.at(-1)!.m.text).toMatch(/plan meter is at 85%/)
  })

  it('fails with an actionable error when Codex is missing', async () => {
    const r = await generateChatImages(make({ GENIO_CODEX_BIN: path.join(tmp, 'no-codex.exe') }), args.parse({ prompt: 'a gem' }))
    expect(r.isError).toBe(true)
    expect((r.content[0] as { text: string }).text).toMatch(/Systems → Accounts/)
    const last = posts.at(-1)!
    expect(last).toMatchObject({ persist: true, m: { id: posts[0].m.id, role: 'error' } })
    expect(last.m.text).toMatch(/^Image generation failed: Codex is not installed.*log in to Codex in Systems → Accounts/)
    expect(fs.existsSync(gen.chatDir) ? fs.readdirSync(gen.chatDir) : []).toEqual([])
  })

  it('fails clearly when Codex produced no image', async () => {
    const r = await generateChatImages(make({ FAKE_CODEX_MODE: 'no-image' }), args.parse({ prompt: 'a gem' }))
    expect(r.isError).toBe(true)
    expect(posts.at(-1)!.m).toMatchObject({ role: 'error' })
    expect(posts.at(-1)!.m.text).toMatch(/made no image/)
    expect(posts.at(-1)!.m.images).toBeUndefined()
  })

  it('refuses a bad ref before running Codex or posting anything', async () => {
    const r = await generateChatImages(gen, args.parse({ prompt: 'a gem', refs: ['missing-1.png'] }))
    expect(r.isError).toBe(true)
    expect(posts).toEqual([])
    expect(fs.existsSync(path.join(codexHome, 'fake-args.json'))).toBe(false)
  })
})

describe('helpers', () => {
  it('reads PNG dimensions', () => {
    expect(pngSize(Buffer.from(PNG1, 'base64'))).toEqual({ width: 1, height: 1 })
    expect(pngSize(Buffer.from('not a png at all, really not'))).toBeUndefined()
  })

  it('maps helper failures to short actionable errors', () => {
    expect(friendlyError('Codex CLI not found on PATH. Install it')).toMatch(/not installed.*Systems → Accounts/)
    expect(friendlyError('Codex gave no thread id (exit 1).')).toMatch(/logged in\?.*Systems → Accounts/)
    expect(friendlyError('Codex made no image for this item.')).toMatch(/made no image/)
  })
})
