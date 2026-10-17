import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RUNTIME_FILES, VOICE_DOWNLOADS, VOICE_RATE, VoiceInput, cleanTranscript, encodeWav, extractZip, serverArgs, speechLevel, splitClip, voicePrompt,
  type VoiceInputOptions
} from '../src/main/voice-input'

// No real model, microphone or download: a fake whisper-server (a Node script) and a fake fetch.
const FAKE_SERVER = `
const http = require('node:http'), fs = require('node:fs'), path = require('node:path')
const args = process.argv.slice(2), port = Number(args[args.indexOf('--port') + 1]), dir = process.env.FAKE_DIR
fs.writeFileSync(path.join(dir, 'args.json'), JSON.stringify(args))
http.createServer((req, res) => {
  if (req.method === 'GET') { res.end('ok'); return }
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const prompt = /name="prompt"\\r\\n\\r\\n([^\\r]*)/.exec(body.toString('latin1'))?.[1] ?? ''
    fs.appendFileSync(path.join(dir, 'requests.jsonl'), JSON.stringify({ bytes: body.length, prompt }) + '\\n')
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ text: fs.readFileSync(path.join(dir, 'reply.txt'), 'utf8') }))
  })
}).listen(port, '127.0.0.1')
`

const dirs: string[] = []
const services: VoiceInput[] = []
afterEach(() => {
  for (const s of services.splice(0)) s.stop()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-voice-'))
  dirs.push(d)
  return d
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/** A zip writer for the test's fake runtime (deflate). */
function zipOf(files: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const [name, data] of Object.entries(files)) {
    const packed = deflateRawSync(data), n = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(8, 10); dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(n.length, 28); dir.writeUInt32LE(offset, 42)
    locals.push(local, n, packed)
    central.push(dir, n)
    offset += 30 + n.length + packed.length
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

/** A fake runtime zip and model with their pins, and a fetch that serves them (with Range support). */
function fakeDownloads(): { downloads: typeof VOICE_DOWNLOADS; fetch: typeof fetch; calls: { url: string; range?: string }[]; zip: Buffer; model: Buffer } {
  const zip = zipOf(Object.fromEntries([...RUNTIME_FILES.map((f) => [`Release/${f}`, Buffer.from(`fake ${f}`)]), ['Release/bench.exe', Buffer.from('other tool')]]))
  const model = Buffer.alloc(100_000, 7)
  const downloads = {
    runtime: { ...VOICE_DOWNLOADS.runtime, url: 'https://example.test/runtime.zip', sha256: sha(zip), size: zip.length },
    model: { ...VOICE_DOWNLOADS.model, url: 'https://example.test/model.bin', sha256: sha(model), size: model.length }
  }
  const calls: { url: string; range?: string }[] = []
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.Range
    calls.push({ url, range })
    const body = url.endsWith('.zip') ? zip : model
    const from = range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0
    return new Response(new Uint8Array(body.subarray(from)), { status: range ? 206 : 200 })
  }) as unknown as typeof fetch
  return { downloads, fetch: fakeFetch, calls, zip, model }
}

/** An installed voice folder (fake files) and a service whose server is the fake script. */
function installed(extra: Partial<VoiceInputOptions> = {}): { voice: VoiceInput; dir: string; unlocked: string[]; requests: () => { bytes: number; prompt: string }[] } {
  const dir = tmp()
  const runtime = path.join(dir, 'runtime')
  fs.mkdirSync(runtime)
  for (const f of RUNTIME_FILES) fs.writeFileSync(path.join(runtime, f), 'fake')
  fs.writeFileSync(path.join(dir, VOICE_DOWNLOADS.model.file), 'fake model')
  fs.writeFileSync(path.join(dir, 'ready.json'), JSON.stringify({ runtime: VOICE_DOWNLOADS.runtime.sha256, model: VOICE_DOWNLOADS.model.sha256 }))
  fs.writeFileSync(path.join(dir, 'server.cjs'), FAKE_SERVER)
  fs.writeFileSync(path.join(dir, 'reply.txt'), ' Ask the Modeller for a chest. ')
  const unlocked: string[] = []
  const voice = new VoiceInput({
    dir,
    names: () => ['Space Miner', 'inventory screen'],
    unlock: (id) => unlocked.push(id),
    spawnServer: (_exe, args) => spawn(process.execPath, [path.join(dir, 'server.cjs'), ...args], { env: { ...process.env, FAKE_DIR: dir }, stdio: 'ignore' }),
    ...extra
  })
  services.push(voice)
  const requests = (): { bytes: number; prompt: string }[] => {
    const f = path.join(dir, 'requests.jsonl')
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
  }
  return { voice, dir, unlocked, requests }
}

/** A voice-like clip: a 200 Hz tone at `amp`, `seconds` long. */
function tone(seconds: number, amp = 0.2): Float32Array {
  const pcm = new Float32Array(Math.round(seconds * VOICE_RATE))
  for (let i = 0; i < pcm.length; i++) pcm[i] = amp * Math.sin((2 * Math.PI * 200 * i) / VOICE_RATE)
  return pcm
}

describe('voice input: text handling', () => {
  it('sends Genio terms and the current project and unit names as the prompt', () => {
    const prompt = voicePrompt(['Space Miner', 'genio', 'inventory screen'])
    for (const term of ['Genio', 'Modeller', 'FAL', 'Uthana', 'Art Bible', 'Steer', 'Space Miner', 'inventory screen']) expect(prompt).toContain(term)
    expect(prompt.match(/genio/gi)).toHaveLength(1)
    expect(voicePrompt(Array.from({ length: 200 }, (_, i) => `unit number ${i}`)).length).toBeLessThanOrEqual(402)
  })
  it("drops Whisper's silence hallucinations only when no speech was heard", () => {
    expect(cleanTranscript(' Thank you.', false)).toBe('')
    expect(cleanTranscript('[BLANK_AUDIO]', false)).toBe('')
    expect(cleanTranscript(' you', false)).toBe('')
    expect(cleanTranscript(' Thank you.', true)).toBe('Thank you.')
    expect(cleanTranscript(' Merge the fix [BLANK_AUDIO] now.', true)).toBe('Merge the fix now.')
  })
  it('tells silence, quiet noise and speech apart', () => {
    expect(speechLevel(new Float32Array(VOICE_RATE))).toEqual({ speech: false, silent: true })
    expect(speechLevel(tone(1, 0.02))).toEqual({ speech: false, silent: false })
    expect(speechLevel(tone(1, 0.2))).toEqual({ speech: true, silent: false })
  })
  it('splits clips over 15 s at the quietest point near 14 s', () => {
    const clip = tone(40)
    clip.fill(0, Math.round(12.5 * VOICE_RATE), Math.round(12.7 * VOICE_RATE))
    const parts = splitClip(clip)
    expect(parts.length).toBe(3)
    expect(parts[0].length / VOICE_RATE).toBeGreaterThanOrEqual(12.5)
    expect(parts[0].length / VOICE_RATE).toBeLessThanOrEqual(12.7)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(15 * VOICE_RATE)
    expect(parts.reduce((n, p) => n + p.length, 0)).toBe(clip.length)
    expect(splitClip(tone(8))).toHaveLength(1)
  })
  it('encodes 16 kHz mono 16-bit WAV in memory', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2]))
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(24)).toBe(16_000)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect([wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48), wav.readInt16LE(50)]).toEqual([0, 32767, -32767, 32767])
  })
  it('runs the server on loopback, CPU only, with the measured flags', () => {
    const args = serverArgs('model.bin', 4321)
    expect(args.join(' ')).toBe('-m model.bin --host 127.0.0.1 --port 4321 -l en -t 4 -bs 1 -bo 1 -nf -ac 768 -ng')
  })
})

describe('voice input: download', () => {
  it('downloads nothing without the consent call', async () => {
    const dl = fakeDownloads()
    let fetched = 0
    const voice = new VoiceInput({ dir: tmp(), downloads: dl.downloads, fetch: (async () => { fetched++; throw new Error('no') }) as unknown as typeof fetch, unlock: () => {} })
    expect(voice.status()).toMatchObject({ state: 'missing', received: 0, total: dl.zip.length + dl.model.length })
    await expect(voice.transcribe(tone(1))).rejects.toThrow(/not installed/)
    expect(fetched).toBe(0)
  })
  it('downloads, verifies and unpacks only the server files, then reports ready', async () => {
    const dir = tmp(), dl = fakeDownloads(), events: { state: string; received: number }[] = []
    const voice = new VoiceInput({ dir, downloads: dl.downloads, fetch: dl.fetch, unlock: () => {}, publish: (s) => events.push(s) })
    await voice.installModel()
    expect(voice.ready()).toBe(true)
    expect(voice.status().state).toBe('ready')
    expect(fs.readdirSync(path.join(dir, 'runtime')).sort()).toEqual([...RUNTIME_FILES].sort())
    expect(fs.existsSync(path.join(dir, VOICE_DOWNLOADS.runtime.file))).toBe(false)
    expect(fs.readFileSync(path.join(dir, VOICE_DOWNLOADS.model.file))).toEqual(dl.model)
    expect(events.at(-1)?.state).toBe('ready')
  })
  it('resumes a partial download with a Range request', async () => {
    const dir = tmp(), dl = fakeDownloads()
    fs.writeFileSync(path.join(dir, VOICE_DOWNLOADS.model.file + '.part'), dl.model.subarray(0, 40_000))
    const voice = new VoiceInput({ dir, downloads: dl.downloads, fetch: dl.fetch, unlock: () => {} })
    await voice.installModel()
    expect(dl.calls.find((c) => c.url.endsWith('.bin'))?.range).toBe('bytes=40000-')
    expect(fs.readFileSync(path.join(dir, VOICE_DOWNLOADS.model.file))).toEqual(dl.model)
  })
  it('deletes a file whose hash does not match and stays not ready', async () => {
    const dir = tmp(), dl = fakeDownloads()
    const downloads = { ...dl.downloads, model: { ...dl.downloads.model, sha256: '0'.repeat(64) } }
    const errors: string[] = []
    const voice = new VoiceInput({ dir, downloads, fetch: dl.fetch, unlock: () => {}, publish: (s) => { if (s.error) errors.push(s.error) } })
    await expect(voice.installModel()).rejects.toThrow(/damaged/)
    expect(fs.existsSync(path.join(dir, VOICE_DOWNLOADS.model.file + '.part'))).toBe(false)
    expect(fs.existsSync(path.join(dir, VOICE_DOWNLOADS.model.file))).toBe(false)
    expect(voice.ready()).toBe(false)
    expect(errors).toHaveLength(1)
  })
  it('unpacks zip entries by base name only, so nothing lands outside the folder', () => {
    const dir = tmp(), out = path.join(dir, 'out')
    fs.mkdirSync(out)
    extractZip(zipOf({ '../../whisper.dll': Buffer.from('x'), 'Release/ggml.dll': Buffer.from('y') }), ['whisper.dll', 'ggml.dll'], out)
    expect(fs.readdirSync(out).sort()).toEqual(['ggml.dll', 'whisper.dll'])
    expect(fs.existsSync(path.join(dir, 'whisper.dll'))).toBe(false)
    expect(() => extractZip(zipOf({ 'a.dll': Buffer.from('x') }), ['whisper.dll'], out)).toThrow(/missing whisper\.dll/)
  })
})

describe('voice input: the local server', () => {
  it('starts lazily, sends the vocabulary prompt, returns the text and unlocks the achievement', async () => {
    const { voice, dir, unlocked, requests } = installed()
    expect(voice.running()).toBe(false)
    const text = await voice.transcribe(tone(2))
    expect(text).toBe('Ask the Modeller for a chest.')
    expect(voice.running()).toBe(true)
    const args = JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8')) as string[]
    expect(args).toEqual(expect.arrayContaining(['-ac', '768', '-ng', '127.0.0.1']))
    expect(requests()[0].prompt).toContain('Uthana')
    expect(requests()[0].prompt).toContain('Space Miner')
    expect(unlocked).toEqual(['chat-voice'])
  }, 30_000)
  it('skips the model for silence and drops a hallucination heard in noise', async () => {
    const { voice, dir, unlocked } = installed()
    expect(await voice.transcribe(new Float32Array(VOICE_RATE))).toBe('')
    expect(voice.running()).toBe(false)
    fs.writeFileSync(path.join(dir, 'reply.txt'), ' Thank you.')
    expect(await voice.transcribe(tone(1, 0.015))).toBe('')
    expect(unlocked).toEqual([])
  }, 30_000)
  it('sends a long clip in parts of at most 15 s and joins the text', async () => {
    const { voice, requests } = installed()
    const text = await voice.transcribe(tone(40))
    expect(requests()).toHaveLength(3)
    for (const r of requests()) expect(r.bytes).toBeLessThan(15 * VOICE_RATE * 2 + 2000)
    expect(text).toBe('Ask the Modeller for a chest. Ask the Modeller for a chest. Ask the Modeller for a chest.')
  }, 30_000)
  it('stops after the idle time and when Genio quits', async () => {
    const { voice } = installed({ idleMs: 300 })
    await voice.transcribe(tone(1))
    expect(voice.running()).toBe(true)
    await new Promise((r) => setTimeout(r, 600))
    expect(voice.running()).toBe(false)
    await voice.transcribe(tone(1))
    expect(voice.running()).toBe(true)
    voice.stop()
    expect(voice.running()).toBe(false)
    await expect(voice.transcribe(tone(1))).rejects.toThrow(/closing/)
  }, 30_000)
})
