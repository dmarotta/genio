import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ADDON_FILES, MODEL_DIR, MODEL_FILES, VOICE_OUTPUT_DOWNLOADS, VOICE_THREADS, VoiceOutput, extractTar, type VoiceOutputOptions
} from '../src/main/voice-output'
import { routeProjectEvent } from '../src/main/project-windows'
import type { FleetSnapshot } from '../src/shared/types'

// No real model or download: the real helper script driven by a fake addon (tests/fixtures/fake-kokoro-addon.cjs),
// run with this Node, and a fake fetch.
const HELPER = path.resolve('resources/kokoro-helper.cjs')
const FAKE_ADDON = path.resolve('tests/fixtures/fake-kokoro-addon.cjs')

const dirs: string[] = []
const services: VoiceOutput[] = []
afterEach(() => {
  delete process.env.FAKE_KOKORO_FATAL
  for (const s of services.splice(0)) s.stop()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-voice-out-'))
  dirs.push(d)
  return d
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/** A ustar writer for the test's fake addon package. */
function tarOf(files: Record<string, Buffer>): Buffer {
  const parts: Buffer[] = []
  for (const [name, data] of Object.entries(files)) {
    const h = Buffer.alloc(512)
    h.write(name, 0, 100, 'utf8')
    h.write('0000644\0', 100)
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124)
    h.write('        ', 148)
    h[156] = 0x30
    h.write('ustar\0', 257)
    let sum = 0
    for (const b of h) sum += b
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)])
}

/** The model archive as Windows' tar makes it (.tar.bz2 of the kokoro-en-v0_19 folder). */
function modelArchive(): Buffer {
  const src = tmp()
  for (const f of MODEL_FILES) {
    fs.mkdirSync(path.dirname(path.join(src, MODEL_DIR, f)), { recursive: true })
    fs.writeFileSync(path.join(src, MODEL_DIR, f), `fake ${f}`)
  }
  const out = path.join(tmp(), 'model.tar.bz2')
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  expect(spawnSync(tar, ['-cjf', out, '-C', src, MODEL_DIR]).status).toBe(0)
  return fs.readFileSync(out)
}

function fakeDownloads(): { downloads: typeof VOICE_OUTPUT_DOWNLOADS; fetch: typeof fetch; calls: string[] } {
  const tgz = gzipSync(tarOf(Object.fromEntries([...ADDON_FILES.map((f) => [`package/${f}`, Buffer.from(`fake ${f}`)]), ['package/index.js', Buffer.from('loader')]])))
  const model = modelArchive()
  const downloads = {
    runtime: { ...VOICE_OUTPUT_DOWNLOADS.runtime, url: 'https://example.test/addon.tgz', sha256: sha(tgz), size: tgz.length },
    model: { ...VOICE_OUTPUT_DOWNLOADS.model, url: 'https://example.test/model.tar.bz2', sha256: sha(model), size: model.length }
  }
  const calls: string[] = []
  const fakeFetch = (async (url: string) => {
    calls.push(url)
    return new Response(new Uint8Array(url.endsWith('.tgz') ? tgz : model), { status: 200 })
  }) as unknown as typeof fetch
  return { downloads, fetch: fakeFetch, calls }
}

function service(opts: Partial<VoiceOutputOptions> & { dir: string }): { voice: VoiceOutput; unlocked: string[] } {
  const unlocked: string[] = []
  const voice = new VoiceOutput({ helperScript: HELPER, addonFile: FAKE_ADDON, execPath: process.execPath, unlock: (id) => unlocked.push(id), ...opts })
  services.push(voice)
  return { voice, unlocked }
}

/** An installed voice folder with fake files, as the download leaves it. */
function installed(extra: Partial<VoiceOutputOptions> = {}): { voice: VoiceOutput; dir: string; unlocked: string[] } {
  const dir = tmp()
  fs.mkdirSync(path.join(dir, 'runtime'))
  for (const f of ADDON_FILES) fs.writeFileSync(path.join(dir, 'runtime', f), 'fake')
  for (const f of MODEL_FILES) {
    fs.mkdirSync(path.dirname(path.join(dir, MODEL_DIR, f)), { recursive: true })
    fs.writeFileSync(path.join(dir, MODEL_DIR, f), 'fake')
  }
  fs.writeFileSync(path.join(dir, 'ready.json'), JSON.stringify({ runtime: VOICE_OUTPUT_DOWNLOADS.runtime.sha256, model: VOICE_OUTPUT_DOWNLOADS.model.sha256 }))
  return { ...service({ dir, ...extra }), dir }
}

describe('the pinned downloads', () => {
  it('names the sherpa-onnx 1.13.8 addon and Kokoro en v0.19 with their sizes and SHA-256', () => {
    const { runtime, model } = VOICE_OUTPUT_DOWNLOADS
    expect(runtime.url).toBe('https://registry.npmjs.org/sherpa-onnx-win-x64/-/sherpa-onnx-win-x64-1.13.8.tgz')
    expect(model.url).toBe('https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2')
    for (const d of [runtime, model]) expect(d.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(Math.round((runtime.size + model.size) / 1e6)).toBe(329)
  })
})

describe('install', () => {
  it('downloads nothing without the consent call, and refuses to speak until installed', async () => {
    const f = fakeDownloads()
    const { voice } = service({ dir: tmp(), ...f })
    expect(voice.status()).toMatchObject({ state: 'missing', received: 0, declined: false })
    await expect(voice.synth('Hello there.')).rejects.toThrow(/not installed/)
    voice.decline()
    expect(voice.status()).toMatchObject({ state: 'missing', declined: true })
    expect(voice.running()).toBe(false)
    expect(f.calls).toEqual([])
  })

  it('downloads both files on consent, verifies them, keeps only what the helper needs and clears a decline', async () => {
    const f = fakeDownloads()
    const dir = tmp()
    const events: string[] = []
    const { voice } = service({ dir, ...f, publish: (s) => events.push(s.state) })
    voice.decline()
    await voice.installVoice()
    expect(f.calls).toEqual(['https://example.test/addon.tgz', 'https://example.test/model.tar.bz2'])
    expect(voice.ready()).toBe(true)
    expect(voice.status()).toMatchObject({ state: 'ready', declined: false })
    expect(fs.readdirSync(path.join(dir, 'runtime')).sort()).toEqual([...ADDON_FILES].sort())
    expect(fs.readdirSync(dir).sort()).toEqual([MODEL_DIR, 'ready.json', 'runtime'])
    expect(events.at(-1)).toBe('ready')
  })

  it('deletes a download whose hash does not match and is not ready', async () => {
    const f = fakeDownloads()
    const dir = tmp()
    const downloads = { ...f.downloads, model: { ...f.downloads.model, sha256: '0'.repeat(64) } }
    const errors: string[] = []
    const { voice } = service({ dir, fetch: f.fetch, downloads, publish: (s) => { if (s.error) errors.push(s.error) } })
    await expect(voice.installVoice()).rejects.toThrow(/damaged/)
    expect(fs.existsSync(path.join(dir, downloads.model.file))).toBe(false)
    expect(fs.existsSync(path.join(dir, downloads.model.file + '.part'))).toBe(false)
    expect(voice.ready()).toBe(false)
    expect(errors).toEqual(['The download was damaged and has been deleted. Try again.'])
  })

  it('is not ready when the marker names other pins', () => {
    const { voice, dir } = installed()
    fs.writeFileSync(path.join(dir, 'ready.json'), JSON.stringify({ runtime: 'old', model: VOICE_OUTPUT_DOWNLOADS.model.sha256 }))
    expect(voice.status().state).toBe('missing')
  })

  it('extracts files from a tar by base name only', () => {
    const dir = tmp()
    extractTar(tarOf({ 'package/../../evil/sherpa-onnx.node': Buffer.from('addon'), 'package/README.md': Buffer.from('x') }), ['sherpa-onnx.node'], dir)
    expect(fs.readdirSync(dir)).toEqual(['sherpa-onnx.node'])
    expect(() => extractTar(tarOf({ 'package/README.md': Buffer.from('x') }), ['sherpa-onnx.node'], tmp())).toThrow(/missing sherpa-onnx.node/)
  })
})

describe('the helper (fake addon, no model)', () => {
  it('starts lazily with 2 threads, answers each sentence with PCM and unlocks the achievement', async () => {
    const { voice, dir, unlocked } = installed()
    expect(voice.running()).toBe(false)
    const a = await voice.synth('The recon is done.')
    expect(voice.running()).toBe(true)
    expect(a.rate).toBe(24000)
    expect(a.pcm).toBeInstanceOf(Float32Array)
    expect(a.pcm.length).toBe(4 * 2400)
    expect(Math.max(...a.pcm)).toBeGreaterThan(0.1)
    const config = JSON.parse(fs.readFileSync(path.join(dir, MODEL_DIR, 'config.json'), 'utf8'))
    expect(config.model.numThreads).toBe(VOICE_THREADS)
    expect(config.model.kokoro.dataDir).toBe(path.join(dir, MODEL_DIR, 'espeak-ng-data'))
    const [b, c] = await Promise.all([voice.synth('One.'), voice.synth('Two more words.')])
    expect([b.pcm.length, c.pcm.length]).toEqual([2400, 3 * 2400])
    expect(unlocked).toContain('voice-natural')
  })

  it('cancel fails a sentence in progress at once; its late audio is dropped and the next sentence gets its own', async () => {
    const { voice } = installed()
    await voice.synth('Warm up.')
    const slow = voice.synth('A slow long sentence.')
    await new Promise((r) => setTimeout(r, 100))
    const t = Date.now()
    voice.cancel()
    await expect(slow).rejects.toThrow(/Cancelled/)
    expect(Date.now() - t).toBeLessThan(100)
    const next = await voice.synth('Next.')
    expect(next.pcm.length).toBe(2400)
  })

  it('reports a failed sentence and keeps going', async () => {
    const { voice } = installed()
    await expect(voice.synth('This will fail.')).rejects.toThrow(/fake failure/)
    expect((await voice.synth('Fine.')).pcm.length).toBe(2400)
  })

  it('fails every request when the helper cannot load the model', async () => {
    process.env.FAKE_KOKORO_FATAL = '1'
    const { voice } = installed()
    await expect(voice.synth('Hello.')).rejects.toThrow(/could not start: fake model is broken/)
    expect(voice.running()).toBe(false)
  })

  it('exits after the idle time and when Genio quits', async () => {
    const { voice } = installed({ idleMs: 150 })
    await voice.synth('Hello.')
    expect(voice.running()).toBe(true)
    await new Promise((r) => setTimeout(r, 400))
    expect(voice.running()).toBe(false)
    await voice.synth('Again.')
    voice.stop()
    expect(voice.running()).toBe(false)
    await expect(voice.synth('After quit.')).rejects.toThrow(/closing/)
  })
})

describe('routing', () => {
  it('a reply is spoken only in the windows that show its chat, never in the Hub', () => {
    const snap = { tasks: [], projects: [] } as unknown as FleetSnapshot
    const ev = { type: 'speak' as const, wksp: 'genio-alpha', text: 'Done.' }
    expect(routeProjectEvent(ev, { project: 'alpha', wksp: 'genio-alpha' } as never, snap)).toEqual(ev)
    expect(routeProjectEvent(ev, { project: 'beta', wksp: 'genio-beta' } as never, snap)).toBeUndefined()
    expect(routeProjectEvent(ev, undefined, snap)).toBeUndefined()
  })
})
