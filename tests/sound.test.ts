import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as dsp from '../resources/unit-skills/genio/skills/sound/scripts/dsp.mjs'
import * as kernel from '../resources/unit-skills/genio/skills/sound/scripts/sound.mjs'
import type { Manifest, Receipt, Recipe, StepDone, StepFailed } from '../resources/unit-skills/genio/skills/sound/scripts/sound.mjs'

const CLI = path.resolve('resources/unit-skills/genio/skills/sound/scripts/sound.mjs')
const KEY = 'fal-test-key-sound:0123456789abcdef'
const EL = 'fal-ai/elevenlabs/sound-effects/v2'
const SONILO = 'sonilo/v1.1/text-to-sound-effects'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-sound-test-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const sha = (p: string): string => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const readJson = (p: string): any => JSON.parse(fs.readFileSync(p, 'utf8'))
const readLines = (p: string): any[] => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const done = (r: StepDone | StepFailed): StepDone => {
  if (!r.ok) throw new Error(`step failed: ${r.kind} ${r.error}`)
  return r
}
const failed = (r: StepDone | StepFailed): StepFailed => {
  if (r.ok) throw new Error(`step ${r.id} should have failed`)
  return r
}
function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name]))
}

/** A generated "door slam": 0.2 s of silence, then a decaying noise burst. */
function slam(seconds: number, { amp = 0.6, lead = 0.2, channels = 1, seed = 7 } = {}): dsp.Audio {
  let s = seed
  const next = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1
  const n = Math.round(seconds * 48000), start = Math.round(lead * 48000)
  return dsp.makeAudio(48000, Array.from({ length: channels }, () => Float32Array.from({ length: n }, (_, i) => (i < start ? 0 : amp * next() * Math.exp(-(i - start) / 9000)))))
}

let dataDir = '', world = ''
beforeEach(() => {
  const t = fs.mkdtempSync(path.join(root, 't-'))
  dataDir = path.join(t, 'data')
  world = path.join(t, 'world')
  fs.mkdirSync(path.join(world, 'src'), { recursive: true })
  fs.writeFileSync(path.join(world, 'src', 'door.wav'), dsp.encodeWav(slam(1.2), { bits: 16 }))
})
const manifest = (set = 'door'): Manifest => readJson(path.join(dataDir, set, 'manifest.json'))

// ---- a fake FAL: pricing, queue, status, result and the audio file itself ----
interface Post { endpoint: string; body: Record<string, any> }
let server: http.Server
let base = ''
const posts: Post[] = []
let prices: Record<string, number> = {}
let deliver: (endpoint: string, body: Record<string, any>) => dsp.Audio = () => slam(1, { channels: 2 })
beforeEach(async () => {
  posts.length = 0
  prices = { [EL]: 0.002, [SONILO]: 0.0018 }
  deliver = (endpoint, body) => slam(Number(body.duration_seconds ?? body.duration), { channels: endpoint === EL ? 2 : 1, lead: 0.05, seed: posts.length + 1 })
  const audio = new Map<string, Buffer>()
  const results = new Map<string, unknown>()
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const json = (code: number, v: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)) }
      const url = req.url ?? ''
      if (url.startsWith('/files/')) { res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(audio.get(url.slice(7))); return }
      if (req.headers.authorization !== `Key ${KEY}`) return json(401, { detail: 'no key' })
      if (req.method === 'GET' && url.startsWith('/v1/models/pricing?')) {
        const endpoint = new URL(url, base).searchParams.get('endpoint_id')!
        return json(200, { prices: [{ endpoint_id: endpoint, unit_price: prices[endpoint], unit: 'seconds', currency: 'USD' }] })
      }
      const req1 = /^\/queue\/(.+?)\/requests\/(r\d+)(\/status)?$/.exec(url)
      if (req1) return req1[3] ? json(200, { status: 'COMPLETED' }) : json(200, results.get(req1[2]))
      if (req.method === 'POST' && url.startsWith('/queue/')) {
        const endpoint = url.slice(7), body = JSON.parse(raw)
        posts.push({ endpoint, body })
        const id = `r${posts.length}`, file = { url: `${base}/files/${id}.wav`, content_type: 'audio/L16; rate=48000; channels=2', file_name: 'sound_effect.wav' }
        audio.set(`${id}.wav`, dsp.encodeWav(deliver(endpoint, body), { bits: 16 }))
        results.set(id, endpoint === SONILO ? { audio: file, audios: [file] } : { audio: file })
        const r = `${base}/queue/${endpoint.split('/')[0]}/requests/${id}`
        return json(200, { request_id: id, status_url: `${r}/status`, response_url: r, cancel_url: `${r}/cancel` })
      }
      json(404, {})
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(() => new Promise<void>((r) => server.close(() => r())))

const env = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => {
  const e: Record<string, string | undefined> = { ...process.env, FAL_KEY: KEY, GENIO_FAL_TEST_BASE: base, GENIO_TASK_ID: 't-sound1', ...extra }
  delete e.GENIO_ART_BIBLE
  return e
}
const init = (extra: Partial<Parameters<typeof kernel.init>[0]> = {}) => kernel.init({ dataDir, set: 'door', cwd: world, world, ...extra })
const step = (recipe: Recipe | string, extra: Partial<Parameters<typeof kernel.step>[0]> = {}) => kernel.step({ dataDir, set: 'door', recipe, world, env: env(), ...extra })
const ledger = () => readLines(path.join(world, '.genio', 'spend.jsonl'))
const fal = (name: string, seconds: number, extra: Record<string, unknown> = {}, endpoint = EL) => ({
  name, source: { fal: { endpoint, input: endpoint === EL ? { text: `heavy wooden door slam ${name}`, duration_seconds: seconds, ...extra } : { prompt: `heavy wooden door slam ${name}`, duration: seconds, ...extra } } }
})

describe('Sound Studio kernel', { timeout: 60000 }, () => {
  it('creates a set outside the project with the default USD 0.50 cap, and refuses music, bad names and data inside the project', async () => {
    const r = await init({ kind: 'sfx', target: 'unity' })
    expect(r).toMatchObject({ ok: true, existing: false, set: 'door', kind: 'sfx', target: 'unity', budget_usd: 0.5, branch: 'main', head: null, takes: {} })
    expect(await init({ budget: 1.25 })).toMatchObject({ existing: true, budget_usd: 1.25 })
    expect(manifest().history).toMatchObject([{ op: 'budget', from: 0.5, to: 1.25 }])
    await expect(init({ kind: 'music' })).rejects.toThrow(/kind is sfx, ui, ambience/)
    await expect(kernel.init({ dataDir: path.join(world, 'data'), set: 'door', cwd: world })).rejects.toThrow(/outside the project/)
    await expect(init({ set: '../escape' })).rejects.toThrow(/Set name/)
  })

  it('makes takes from a file and from earlier takes: masters, sheets and receipts in step data, none in the project', async () => {
    await init()
    const s1 = done(await step({
      caption: 'One heavy slam, trimmed and levelled',
      takes: [{ name: 'door-01', source: { file: 'src/door.wav' }, ops: [{ trim: { db: -60 } }, { fade: { out_ms: 30 } }, { normalize: { peak_db: -1 } }] }]
    }))
    expect(s1).toMatchObject({ id: 's001', n: 1, parent: null, caption: 'One heavy slam, trimmed and levelled', est_usd: 0, takes: [{ name: 'door-01', peak_dbfs: -1 }] })
    expect(s1.takes[0].duration_s).toBeCloseTo(1.005, 2)
    for (const f of [s1.takes[0].file, s1.takes[0].sheet, s1.receipt]) expect(fs.existsSync(f)).toBe(true)
    expect(path.relative(world, s1.takes[0].file).startsWith('..')).toBe(true)
    const master = dsp.readWav(s1.takes[0].file)
    expect(master).toMatchObject({ rate: 48000, info: { source_bits: 24 } })
    const receipt: Receipt = readJson(s1.receipt)
    expect(receipt.takes[0]).toMatchObject({ name: 'door-01', source: 'file', lineage: { fal: [], files: ['src/door.wav'], takes: [] }, metrics: { lead_silence_s: 0, source_bits: 16 } })

    const s2 = done(await step({
      caption: 'Two variations: lower and quicker',
      takes: [
        { name: 'door-02', source: { take: 'door-01' }, ops: [{ pitch: { semitones: -2 } }, { gain: { db: -1 } }] },
        { name: 'door-03', source: { take: 'door-01' }, ops: [{ rate: { factor: 1.1 } }, { mix: { take: 'door-02', gain_db: -12 } }] }
      ]
    }))
    expect(s2).toMatchObject({ id: 's002', parent: 's001' })
    const st = await kernel.status({ dataDir, set: 'door' })
    expect(Object.keys(st.takes)).toEqual(['door-01', 'door-02', 'door-03'])
    expect(st.takes['door-01']).toMatchObject({ step: 's001', file: 'steps/s001/door-01.wav' })
    expect(st.takes['door-03']).toMatchObject({ step: 's002' })
    // pitch -2 st by varispeed is longer
    expect(st.takes['door-02'].duration_s).toBeCloseTo(1.005 * 2 ** (2 / 12), 2)
    const r2: Receipt = readJson(s2.receipt)
    expect(r2.takes[1].lineage).toEqual({ fal: [], files: ['src/door.wav'], takes: ['s001:door-01', 's002:door-02'] })
    // takes never land in the project
    expect(files(world)).toEqual(['src/door.wav'])
    expect(files(path.join(dataDir, 'door', 'steps')).filter((f) => f.startsWith('.'))).toEqual([])
  })

  it('reverts to step N and branches from a step; a take from any step is reachable as sNNN:name; drop removes a take', async () => {
    await init()
    done(await step({ caption: 'Base', takes: [{ name: 'a', source: { file: 'src/door.wav' } }] }))
    done(await step({ caption: 'Louder', takes: [{ name: 'a', source: { take: 'a' }, ops: [{ gain: { db: 3 } }] }] }))
    done(await step({ caption: 'Second', takes: [{ name: 'b', source: { take: 'a' }, ops: [{ pitch: { semitones: 2 } }] }] }))
    const reverted = await kernel.revert({ dataDir, set: 'door', to: 1 })
    expect(reverted).toMatchObject({ head: 's001', reverted: 's003' })
    expect(Object.keys(reverted.takes)).toEqual(['a'])
    expect(reverted.takes.a.step).toBe('s001')
    const s4 = done(await step({ caption: 'Quieter instead', takes: [{ name: 'a', source: { take: 'a' }, ops: [{ gain: { db: -3 } }] }] }))
    expect(s4).toMatchObject({ id: 's004', parent: 's001' })
    await expect(kernel.revert({ dataDir, set: 'door', to: 's003' })).rejects.toThrow(/not on branch main.*sound\.mjs branch door <name> --from s003/)

    const alt = await kernel.branch({ dataDir, set: 'door', name: 'alt', from: 's003' })
    expect(alt).toMatchObject({ branch: 'alt', head: 's003', branches: { main: { head: 's004' }, alt: { head: 's003', from: 's003' } } })
    expect(Object.keys(alt.takes)).toEqual(['a', 'b'])
    // the quieter take on main, reached from the other branch by its step
    const s5 = done(await step({ caption: 'Layer main\'s quiet take; drop b', drop: ['b'], takes: [{ name: 'c', source: { take: 's004:a' }, ops: [{ mix: { take: 'a', gain_db: -6 } }] }] }))
    expect(s5).toMatchObject({ id: 's005', parent: 's003', branch: 'alt' })
    expect(Object.keys((await kernel.status({ dataDir, set: 'door' })).takes)).toEqual(['a', 'c'])
    const r5: Receipt = readJson(s5.receipt)
    // s004:a was made from s001:a; the layer is main's s002:a as the alt branch sees it
    expect(r5.takes[0].lineage.takes).toEqual(['s001:a', 's004:a', 's002:a'])
    expect(failed(await step({ caption: 'Bad drop', drop: ['zzz'] }))).toMatchObject({ kind: 'error', error: expect.stringMatching(/Cannot drop zzz/) })
    await expect(kernel.branch({ dataDir, set: 'door', name: 'alt' })).rejects.toThrow(/already exists/)
    const back = await kernel.switchBranch({ dataDir, set: 'door', name: 'main' })
    expect(back.steps.map((s) => s.id)).toEqual(['s001', 's004'])
    expect(manifest().history.map((h) => h.op)).toEqual(['revert', 'branch', 'switch'])
    await expect(step({ caption: 'Missing', takes: [{ name: 'x', source: { take: 'nope' } }] }).then(failed)).resolves.toMatchObject({ error: expect.stringMatching(/No take nope in the set so far/) })
  })

  it('checks a recipe completely before running it', async () => {
    await init()
    await expect(step({ takes: [{ name: 'x', source: { file: 'src/door.wav' }, ops: [{ reverb: {} }] }] })).rejects.toThrow(/Unknown op/)
    await expect(step({ takes: [{ name: 'x', source: { take: 'a', file: 'b' } as never }] })).rejects.toThrow(/source is one of/)
    await expect(step({ takes: [fal('x', 30)] })).rejects.toThrow(/duration_seconds.*0\.5-22 seconds/)
    await expect(step({ takes: [fal('x', 2, { output_format: 'mp3_44100_128' })] })).rejects.toThrow(/decodes WAV\/PCM only.*pcm_48000/)
    await expect(step({ takes: [{ name: 'x', source: { fal: { endpoint: 'fal-ai/stable-audio-3/small/music/text-to-audio', input: { prompt: 'lofi' } } } }] })).rejects.toThrow(/v1 generates with/)
    await expect(step({ takes: [{ name: 'x', source: { file: 'a.wav' } }, { name: 'x', source: { file: 'a.wav' } }] })).rejects.toThrow(/appears twice/)
    await expect(step({ caption: 'nothing' })).rejects.toThrow(/makes no takes/)
    expect(posts).toEqual([])
    expect(manifest().steps).toEqual([])
  })

  it('generates takes through fal.mjs with the budget, logs spend lines and keeps every download out of the project', async () => {
    await init()
    const r = done(await step({
      caption: 'Two slams from two models',
      takes: [
        { ...fal('door-01', 1.5), ops: [{ trim: {} }, { fade: { out_ms: 20 } }, { normalize: { peak_db: -1 } }] },
        { ...fal('door-02', 2, {}, SONILO), ops: [{ trim: {} }, { normalize: { peak_db: -1 } }] }
      ]
    }))
    expect(posts.map((p) => p.endpoint)).toEqual([EL, SONILO])
    expect(posts[0].body).toEqual({ text: 'heavy wooden door slam door-01', duration_seconds: 1.5, output_format: 'pcm_48000' })
    expect(posts[1].body).toEqual({ prompt: 'heavy wooden door slam door-02', duration: 2, audio_format: 'wav' })
    expect(r.est_usd).toBeCloseTo(0.0066, 6)
    expect(r.takes.map((t) => [t.name, t.peak_dbfs])).toEqual([['door-01', -1], ['door-02', -1]])
    expect(ledger()).toMatchObject([
      { provider: 'fal', endpoint: EL, request_id: 'r1', units: 1.5, est_usd: 0.003, by: 'unit:t-sound1' },
      { provider: 'fal', endpoint: SONILO, request_id: 'r2', units: 2, est_usd: 0.0036, by: 'unit:t-sound1' }
    ])
    const receipt: Receipt = readJson(r.receipt)
    expect(receipt.takes[0].lineage.fal).toMatchObject([{ endpoint: EL, request_id: 'r1', est_usd: 0.003, units: 1.5, resumed: false }])
    expect(receipt.takes[0].metrics).toMatchObject({ source_bits: 16, channels: 2 })
    // the project only gained the spend ledger: no takes, no raw downloads, no provenance for step data
    expect(files(world).sort()).toEqual(['.genio/spend.jsonl', 'src/door.wav'])
    expect(fs.existsSync(path.join(dataDir, 'door', 'raw', 's001-door-01', 'door-01.wav'))).toBe(true)
    expect(manifest()).toMatchObject({ spent_usd: 0.0066 })
    expect(await kernel.budgetInfo({ dataDir, set: 'door', world, env: env() })).toMatchObject({ budget_usd: 0.5, spent_usd: 0.0066, remaining_usd: 0.4934 })
  })

  it('flags a quiet FAL take (regenerate, do not normalize) and a short delivery as length drift, without refusing either', async () => {
    await init()
    deliver = (_, body) => slam(Number(body.duration_seconds) - 0.5, { amp: 136 / 32768, lead: 0.01 })
    const r = done(await step({ caption: 'A gentle, distant slam', takes: [{ ...fal('soft', 2), ops: [{ normalize: { peak_db: -1 } }] }] }))
    expect(r.takes[0].warnings.join('\n')).toMatch(/length drift: FAL delivered 1\.5 s for the 2 s asked/)
    expect(r.takes[0].warnings.join('\n')).toMatch(/too quiet: .*regenerate it rather than normalize/)
    expect(r.takes[0].peak_dbfs).toBe(-1)
  })

  it('stops at the budget before any paid call: for the whole step, against what was already spent, and in fal.mjs per call', async () => {
    await init({ budget: 0.01 })
    // 3 x 2 s at USD 0.002/s = 0.012 > 0.01: refused up front, nothing submitted
    const three = { caption: 'Three takes', takes: ['a', 'b', 'c'].map((n) => fal(n, 2)) }
    await expect(step(three)).rejects.toThrow(/Budget hard stop.*exceeds your USD 0\.01 budget.*3 paid take\(s\), est\. USD 0\.012\. Nothing was submitted/)
    expect(posts).toHaveLength(0)
    expect(manifest()).toMatchObject({ steps: [], failures: [{ id: 's001', kind: 'budget' }] })
    // a batch is priced as a whole: two steps of 0.006 each do not fit together
    await expect(kernel.batch({ dataDir, set: 'door', recipes: [{ caption: 'one', takes: [fal('a', 3)] }, { caption: 'two', takes: [fal('b', 3)] }], world, env: env() })).rejects.toThrow(/Budget hard stop/)
    expect(posts).toHaveLength(0)
    // a raised budget lets it through; earlier spend in the world's ledger counts against it
    fs.mkdirSync(path.join(world, '.genio'), { recursive: true })
    fs.writeFileSync(path.join(world, '.genio', 'spend.jsonl'), JSON.stringify({ t: new Date().toISOString(), provider: 'fal', endpoint: EL, request_id: 'old', est_usd: 0.495, by: 'unit:t-sound1' }) + '\n')
    await init({ budget: 0.5 })
    await expect(step({ caption: 'One more', takes: [fal('a', 3)] })).rejects.toThrow(/on top of USD 0\.495 already spent exceeds your USD 0\.5 budget/)
    expect(done(await step({ caption: 'One more, on a raised budget', takes: [fal('a', 3)] }, { budget: 1 }))).toMatchObject({ est_usd: 0.006 })
    expect(posts).toHaveLength(1)
    // fal.mjs gates each call on FAL's live price too: priced far above the catalogue, it refuses and nothing is paid
    prices[EL] = 0.5
    const stopped = failed(await step({ caption: 'Priced up', takes: [fal('b', 2)] }, { budget: 1 }))
    expect(stopped).toMatchObject({ kind: 'budget', head: 's001', paid: [] })
    expect(stopped.error).toMatch(/Budget hard stop/)
    expect(posts).toHaveLength(1)
    expect(ledger().map((l) => l.request_id)).toEqual(['old', 'r1'])
  })

  it('needs the FAL key only for paid takes', async () => {
    await init()
    const r = failed(await step({ caption: 'No key', takes: [fal('a', 1)] }, { env: env({ FAL_KEY: undefined }) }))
    expect(r).toMatchObject({ kind: 'fal', error: expect.stringMatching(/FAL key missing/) })
    expect(posts).toHaveLength(0)
    done(await step({ caption: 'Local', takes: [{ name: 'a', source: { file: 'src/door.wav' } }] }, { env: env({ FAL_KEY: undefined }) }))
  })

  it('keeps a paid take when a later take of the step fails, and resumes it for free when the recipe runs again', async () => {
    await init()
    const broken = { caption: 'Slam and a layer', takes: [fal('body', 1), { name: 'layered', source: { take: 'missing' } }] }
    const r = failed(await step(broken))
    expect(r).toMatchObject({ id: 's001', kind: 'error', paid: [{ take: 'body', request_id: 'r1', est_usd: 0.002 }] })
    expect(r.message).toMatch(/re-running the same recipe resumes them without paying again/)
    expect(manifest()).toMatchObject({ steps: [], spent_usd: 0.002, failures: [{ id: 's001', kind: 'error', paid: [{ request_id: 'r1' }] }] })
    expect(fs.readdirSync(path.join(dataDir, 'door', 'failed'))).toEqual([expect.stringMatching(/^s001-error-\d+$/)])
    const fixed = done(await step({ ...broken, takes: [fal('body', 1), { name: 'layered', source: { take: 'body' }, ops: [{ pitch: { semitones: 3 } }] }] }))
    expect(fixed).toMatchObject({ id: 's001', est_usd: 0 })
    expect(posts).toHaveLength(1)
    expect(ledger()).toHaveLength(1)
    expect(readJson(fixed.receipt).takes[0].lineage.fal[0]).toMatchObject({ request_id: 'r1', resumed: true })
    // a changed prompt under the same step id is a new call, not a resume
    done(await kernel.revert({ dataDir, set: 'door', to: 1 }).then(() => step({ caption: 'Again', takes: [fal('other', 1)] })))
    expect(posts).toHaveLength(2)
  })

  it('exports the final WAVs with derived provenance, spend lines and the recipes under .genio/sound/<set>/', async () => {
    await init({ target: 'unity' })
    done(await step({ caption: 'Generated slam', takes: [{ ...fal('door-01', 1.5), ops: [{ trim: {} }, { normalize: { peak_db: -1 } }] }] }))
    done(await step({ caption: 'A free variation', takes: [{ name: 'door-02', source: { take: 'door-01' }, ops: [{ pitch: { semitones: -2 } }] }] }))
    const out = await kernel.exportSet({ dataDir, set: 'door', world, to: 'Assets/Audio/SFX', env: env() })
    expect(out).toMatchObject({ ok: true, step: 's002', recipes: '.genio/sound/door', est_usd: 0.006 })
    expect(out.exported.map((x) => [x.take, x.path])).toEqual([['door-01', 'Assets/Audio/SFX/door-01.wav'], ['door-02', 'Assets/Audio/SFX/door-02.wav']])
    const wav = dsp.readWav(path.join(world, 'Assets/Audio/SFX/door-02.wav'))
    expect(wav).toMatchObject({ rate: 48000, info: { source_bits: 16 } })
    expect(wav.data).toHaveLength(2)
    // provenance for the derived file: local, derived from the FAL request, with the recipe that made it
    const prov = readJson(path.join(world, '.genio/provenance/Assets/Audio/SFX/door-02.wav.json'))
    expect(prov).toMatchObject({
      schema: 'genio.provenance.v1', path: 'Assets/Audio/SFX/door-02.wav', sha256: sha(path.join(world, 'Assets/Audio/SFX/door-02.wav')),
      provider: 'local', endpoint: 'genio/sound', request_id: null, recipe: '.genio/sound/door/steps/s002.json',
      derived_from: ['r1'], price: { estimated_usd: 0.003 }, by: 'unit:t-sound1',
      sources: [{ endpoint: EL, request_id: 'r1', est_usd: 0.003, input: { text: 'heavy wooden door slam door-01', duration_seconds: 1.5, output_format: 'pcm_48000' } }],
      takes: ['s001:door-01'], input: { set: 'door', step: 's002', take: 'door-02', bits: 16, rate: 48000, channels: 2 }
    })
    expect(out.exported[1].spend).toMatchObject([{ request_id: 'r1', est_usd: 0.003 }])
    // the recipes and a manifest copy, never the takes
    expect(files(path.join(world, '.genio', 'sound', 'door')).sort()).toEqual(['exports.json', 'manifest.json', 'steps/s001.json', 'steps/s002.json'])
    expect(readJson(path.join(world, '.genio/sound/door/steps/s002.json'))).toMatchObject({ id: 's002', parent: 's001', caption: 'A free variation', takes: [{ name: 'door-02', source: { take: 'door-01' } }] })
    expect(files(world).filter((f) => f.endsWith('.wav')).sort()).toEqual(['Assets/Audio/SFX/door-01.wav', 'Assets/Audio/SFX/door-02.wav', 'src/door.wav'])
    // claimed paths are not overwritten by accident; the project and .genio/ are the limits
    await expect(kernel.exportSet({ dataDir, set: 'door', world, to: 'Assets/Audio/SFX', env: env() })).rejects.toThrow(/already exists.*--overwrite/)
    await expect(kernel.exportSet({ dataDir, set: 'door', world, takes: ['door-01'], to: '.genio/x.wav', env: env() })).rejects.toThrow(/outside \.genio/)
    await expect(kernel.exportSet({ dataDir, set: 'door', world, takes: ['door-01'], to: path.join(root, 'elsewhere.wav'), env: env() })).rejects.toThrow(/inside the project/)
    await expect(kernel.exportSet({ dataDir, set: 'door', world, to: 'Assets/one.wav', env: env() })).rejects.toThrow(/names one file, but 2 takes/)
    const one = await kernel.exportSet({ dataDir, set: 'door', world, takes: ['door-01'], step: 's001', to: 'Assets/Audio/SFX/door-01.wav', bits: 24, overwrite: true, env: env() })
    expect(dsp.readWav(path.join(world, one.exported[0].path)).info.source_bits).toBe(24)
    expect(readJson(path.join(world, '.genio/sound/door/exports.json')).map((e: { path: string }) => e.path).sort()).toEqual(['Assets/Audio/SFX/door-01.wav', 'Assets/Audio/SFX/door-02.wav'])
    // a spend line the ledger lacks (generated against another world) is added at export, once
    fs.writeFileSync(path.join(world, '.genio', 'spend.jsonl'), '')
    const again = await kernel.exportSet({ dataDir, set: 'door', world, takes: ['door-02'], to: 'Assets/Audio/SFX/door-02.wav', overwrite: true, env: env() })
    expect(again.exported[0].spend).toMatchObject([{ request_id: 'r1', recorded_at_export: true }])
    expect(ledger()).toHaveLength(1)
  })

  it('round-trips recipes: the exported recipes rebuild the same takes, byte for byte', async () => {
    await init()
    const recipes: Recipe[] = [
      { caption: 'Base slam', takes: [{ name: 'door-01', source: { file: 'src/door.wav' }, ops: [{ trim: {} }, { fade: { in_ms: 2, out_ms: 40, shape: 'equal' } }, { normalize: { peak_db: -1 } }] }] },
      { caption: 'Variations and a layer', takes: [
        { name: 'door-02', source: { take: 'door-01' }, ops: [{ pitch: { semitones: 2 } }, { stereo: {} }] },
        { name: 'door-03', source: { take: 'door-01' }, ops: [{ mix: { take: 'door-02', gain_db: -9, offset_ms: 15 } }, { gain: { db: -2 } }] }
      ] }
    ]
    const r = await kernel.batch({ dataDir, set: 'door', recipes, world, env: env(), gapMs: 0 })
    expect(r).toMatchObject({ ok: true, head: 's002' })
    const stored = readJson(path.join(dataDir, 'door', 'steps', 's002', 'recipe.json'))
    expect(stored).toEqual({ caption: 'Variations and a layer', takes: recipes[1].takes, drop: [] })
    await kernel.exportSet({ dataDir, set: 'door', world, to: 'Assets/Audio', env: env() })
    // rebuild from what the project keeps: .genio/sound/door/steps/*.json
    const dir = path.join(world, '.genio', 'sound', 'door', 'steps')
    await kernel.init({ dataDir, set: 'rebuilt', cwd: world, world })
    const rebuilt = await kernel.batch({ dataDir, set: 'rebuilt', recipes: dir, world, env: env(), gapMs: 0 })
    expect(rebuilt).toMatchObject({ ok: true, head: 's002' })
    const a = await kernel.status({ dataDir, set: 'door' }), b = await kernel.status({ dataDir, set: 'rebuilt' })
    for (const name of ['door-01', 'door-02', 'door-03']) expect(sha(path.join(dataDir, 'rebuilt', b.takes[name].file))).toBe(sha(path.join(dataDir, 'door', a.takes[name].file)))
  })

  it('lands each recipe of a batch in order and spaced out, and stops at a failure', async () => {
    await init()
    const heads: string[] = []
    let watching = true
    const watch = (async () => {
      while (watching) {
        try { const h = manifest().branches.main.head; if (h && heads.at(-1) !== h) heads.push(h) } catch { /* not written yet */ }
        await new Promise((r) => setTimeout(r, 20))
      }
    })()
    const take = (n: string, db: number): Recipe => ({ caption: `Take ${n}`, takes: [{ name: n, source: { file: 'src/door.wav' }, ops: [{ gain: { db } }] }] })
    let r: kernel.BatchDone
    try { r = await kernel.batch({ dataDir, set: 'door', recipes: [take('a', -1), take('b', -2), take('c', -3)], world, env: env() }) } finally {
      watching = false
      await watch
    }
    if (heads.at(-1) !== manifest().branches.main.head) heads.push(manifest().branches.main.head!)
    expect(r).toMatchObject({ ok: true, head: 's003', failure: null })
    expect(heads).toEqual(['s001', 's002', 's003'])
    const at = manifest().steps.map((s) => Date.parse(s.t))
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(kernel.PUBLISH_GAP_MS - 20)
    const stop = await kernel.batch({ dataDir, set: 'door', recipes: [take('d', 0), { caption: 'Bad', takes: [{ name: 'e', source: { take: 'nope' } }] }, take('f', 0)], world, env: env(), gapMs: 0 })
    expect(stop).toMatchObject({ ok: false, head: 's004', failure: { id: 's005', kind: 'error' }, not_run: [{ name: 'step3' }] })
    expect(stop.message).toMatch(/1 of 3 steps landed; s005 \(step2\) failed.*Not run: step3\./)
  })

  it('locks a set against concurrent commands, and steals a stale lock', async () => {
    await init()
    const lock = path.join(dataDir, 'door', '.lock')
    fs.writeFileSync(lock, String(process.pid))
    await expect(step({ caption: 'x', takes: [{ name: 'a', source: { file: 'src/door.wav' } }] })).rejects.toThrow(/Another Sound Studio command/)
    fs.writeFileSync(lock, '2147483646')
    done(await step({ caption: 'x', takes: [{ name: 'a', source: { file: 'src/door.wav' } }] }))
    expect(fs.existsSync(lock)).toBe(false)
  })

  it('serves init, step, status, revert, branch, export and the budget stop through the CLI', async () => {
    const cli = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [CLI, ...args, '--data', dataDir, '--world', world], { cwd: world, env: env() as NodeJS.ProcessEnv }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }))
    })
    expect(JSON.parse((await cli('init', 'door', '--kind', 'ambience')).stdout)).toMatchObject({ ok: true, kind: 'ambience', budget_usd: 0.5 })
    const recipe = path.join(path.dirname(dataDir), 's01_bed.json')
    // written with a BOM, as Windows PowerShell's Set-Content -Encoding utf8 does
    fs.writeFileSync(recipe, '﻿' + JSON.stringify({ caption: 'A looped bed', takes: [{ name: 'bed', source: { file: 'src/door.wav' }, ops: [{ loop: { crossfade_ms: 200 } }] }] }))
    const s = JSON.parse((await cli('step', 'door', recipe)).stdout)
    expect(s).toMatchObject({ ok: true, id: 's001', name: 'bed', caption: 'A looped bed' })
    expect(readJson(s.receipt).takes[0].metrics).toMatchObject({ loop: true, seam: { jump: expect.any(Number) } })
    expect(JSON.parse((await cli('status', 'door')).stdout)).toMatchObject({ head: 's001', steps: [{ id: 's001', takes: ['bed'] }] })
    expect(JSON.parse((await cli('branch', 'door', 'alt', '--from', 's001')).stdout)).toMatchObject({ branch: 'alt' })
    expect(JSON.parse((await cli('revert', 'door', 's001')).stdout)).toMatchObject({ head: 's001' })
    const ex = JSON.parse((await cli('export', 'door', '--to', 'audio/ambience/bed.wav')).stdout)
    expect(ex.exported[0]).toMatchObject({ path: 'audio/ambience/bed.wav', metrics: { loop: true } })
    const over = path.join(path.dirname(dataDir), 'over.json')
    fs.writeFileSync(over, JSON.stringify({ takes: [fal('a', 22), fal('b', 22)] }))
    const stop = await cli('step', 'door', over, '--budget', '0.05')
    expect(stop.code).toBe(6)
    expect(stop.stderr).toMatch(/Budget hard stop/)
    expect(posts).toHaveLength(0)
    const bad = await cli('frobnicate', 'door')
    expect(bad).toMatchObject({ code: 1, stderr: expect.stringContaining('Usage: sound.mjs') })
  })

  it('derives step names and the data folder', () => {
    expect(kernel.stepName('C:/w/s03_heavier.json')).toBe('heavier')
    expect(kernel.stepName('07-less creak.json')).toBe('less-creak')
    expect(kernel.soundDataDir({ GENIO_SOUND_DATA: path.join(root, 's') })).toBe(path.join(root, 's'))
    expect(kernel.soundDataDir({ GENIO_MODELLER_DATA: path.join(root, 'unit', 'modeller') })).toBe(path.join(root, 'unit', 'sound'))
  })
})
