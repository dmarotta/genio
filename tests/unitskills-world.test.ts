import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { unitPluginSource } from '../src/main/unitskills'

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PLUGIN = unitPluginSource(APP_ROOT)
const FAL = path.join(PLUGIN, 'skills', 'fal', 'scripts', 'fal.mjs')
const CODEX_IMAGE = path.join(PLUGIN, 'skills', 'imagegen-codex', 'scripts', 'codex-image.mjs')
const FIXTURES = path.join(APP_ROOT, 'tests', 'fixtures')
const KEY = 'fal-test-key-0000:abcdefabcdefabcdef'

// The helpers are plain .mjs shipped to units; tests load them untyped.
type Mod = Record<string, any>
const load = async (p: string): Promise<Mod> => (await import(pathToFileURL(p).href)) as Mod
let rollout: Mod
let lib: Mod
beforeAll(async () => {
  rollout = await load(path.join(PLUGIN, 'skills', 'imagegen-codex', 'scripts', 'rollout.mjs'))
  lib = await load(path.join(PLUGIN, 'lib', 'genio-world.mjs'))
})

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-world-'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

interface Run {
  code: number
  stdout: string
  stderr: string
}

function runNode(script: string, args: string[], env: Record<string, string | undefined> = {}): Promise<Run> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env }
  for (const k of ['FAL_KEY', 'GENIO_FAL_TEST_BASE', 'GENIO_TASK_ID', 'GENIO_CODEX_BIN', 'GENIO_CODEX_IMAGE_SCRATCH', 'CODEX_HOME', 'GENIO_HOME']) delete childEnv[k]
  Object.assign(childEnv, env)
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { cwd: tmp, env: childEnv }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ code, stdout, stderr })
    })
  })
}

const readJson = (p: string): any => JSON.parse(fs.readFileSync(p, 'utf8'))
const readLines = (p: string): any[] => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const sha = (p: string): string => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

/** A world (the unit's worktree) with an optional .genio/fal/ setup. */
function makeWorld(config?: unknown, recipes?: unknown): string {
  const world = path.join(tmp, 'world')
  fs.mkdirSync(path.join(world, '.genio', 'fal'), { recursive: true })
  if (config !== undefined) fs.writeFileSync(path.join(world, '.genio', 'fal', 'config.json'), JSON.stringify(config, null, 2))
  if (recipes !== undefined) fs.writeFileSync(path.join(world, '.genio', 'fal', 'recipes.json'), JSON.stringify(recipes, null, 2))
  return world
}

describe('Codex rollout parsing (recon evidence)', () => {
  const text = (): string => fs.readFileSync(path.join(FIXTURES, 'codex-rollout-image-gen.jsonl'), 'utf8')

  it('finds the generation, its savedPath and the plan meter', () => {
    const r = rollout.parseRollout(text())
    expect(r.threadId).toBe('01a13474-8d3e-7e30-a6f3-22574b4bf508')
    expect(r.images).toHaveLength(1)
    expect(r.images[0]).toMatchObject({
      id: 'exec-d70a4d79-458a-4fd2-b488-c966a99ad3c1',
      status: 'completed',
      transparentBackground: true,
      failure: null,
      hasInlineResult: true
    })
    expect(r.images[0].savedPath).toMatch(/generated_images\\01a13474-8d3e-7e30-a6f3-22574b4bf508\\exec-d70a4d79-458a-4fd2-b488-c966a99ad3c1\.png$/)
    expect(r.images[0].revisedPrompt).toMatch(/flat solid red circle/)
    expect(r.images[0]).not.toHaveProperty('result')
    expect(r.rateLimits).toMatchObject({ plan_type: 'pro', primary: { used_percent: 1, window_minutes: 10080 } })
    expect(r.completed).toEqual({ durationMs: 77782 })
  })

  it('tolerates a torn last line and decodes the inline image', () => {
    const r = rollout.parseRollout(text() + '{"timestamp":"2026-10-13T08:51:36Z","type":"event_msg","pay')
    expect(r.images).toHaveLength(1)
    const bytes: Buffer = rollout.imageBytes(text(), 'exec-d70a4d79-458a-4fd2-b488-c966a99ad3c1')
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })

  it('reads the thread id from the --json events', () => {
    const ev = '{"type":"thread.started","thread_id":"01a13474-8d3e-7e30-a6f3-22574b4bf508"}\n{"type":"turn.started"}\n'
    expect(rollout.threadIdFromEvents('Reading prompt from stdin...\n' + ev)).toBe('01a13474-8d3e-7e30-a6f3-22574b4bf508')
    expect(rollout.threadIdFromEvents('{"type":"turn.started"}')).toBeNull()
  })

  it('warns at the plan-meter threshold or a reached limit', () => {
    const limits = rollout.parseRollout(text()).rateLimits
    expect(rollout.planMeter(limits, 80)).toMatchObject({ known: true, plan_type: 'pro', used_percent: 1, warning: null })
    expect(rollout.planMeter({ ...limits, primary: { ...limits.primary, used_percent: 85 } }, 80).warning).toMatch(/85%/)
    expect(rollout.planMeter({ ...limits, secondary: { used_percent: 90, window_minutes: 300 } }, 80).used_percent).toBe(90)
    expect(rollout.planMeter({ ...limits, rate_limit_reached_type: 'primary' }, 80).warning).toMatch(/reached/)
    expect(rollout.planMeter(null)).toEqual({ known: false, warning: null })
  })

  it('locates the rollout by thread id, by day folder or by a full scan', () => {
    const sessions = path.join(tmp, 'sessions')
    const id = '01a13474-8d3e-7e30-a6f3-22574b4bf508'
    const day = path.join(sessions, '2026', '10', '13')
    fs.mkdirSync(day, { recursive: true })
    fs.writeFileSync(path.join(day, 'rollout-2026-10-13T10-50-16-other.jsonl'), '')
    const file = path.join(day, `rollout-2026-10-13T10-50-16-${id}.jsonl`)
    fs.writeFileSync(file, '')
    expect(rollout.findRollout(sessions, id, [new Date(2026, 9, 13, 10, 50)])).toBe(file)
    expect(rollout.findRollout(sessions, id, [new Date(2025, 0, 1)])).toBe(file)
    expect(rollout.findRollout(sessions, 'missing', [new Date(2026, 9, 13)])).toBeNull()
  })
})

describe('.genio/ records', () => {
  const now = new Date('2026-10-13T12:00:00Z')
  const lines = [
    { t: '2026-10-02T10:00:00Z', provider: 'fal', est_usd: 0.4, by: 'unit:a' },
    { t: '2026-10-05T10:00:00Z', provider: 'fal', est_usd: 0.5, by: 'player' },
    { t: '2026-09-30T10:00:00Z', provider: 'fal', est_usd: 9, by: 'unit:a' },
    { t: '2026-10-06T10:00:00Z', provider: 'codex', est_usd: 0, plan: 'chatgpt', by: 'unit:a' }
  ]

  it('stops a unit at its brief budget (hard stop)', () => {
    const g = lib.checkBudget({ lines, by: 'unit:a', estUsd: 0.7, unitBudget: 10, config: {}, now })
    expect(g).toMatchObject({ ok: false, spent_by_unit: 9.4 })
    expect(g.reason).toMatch(/hard stop/)
    expect(lib.checkBudget({ lines, by: 'unit:b', estUsd: 0.7, unitBudget: 1, config: {}, now }).ok).toBe(true)
    expect(lib.checkBudget({ lines, by: 'unit:b', estUsd: 1, unitBudget: 1, config: {}, now }).ok).toBe(true)
  })

  it('respects the world monthly cap and the confirm threshold', () => {
    const config = { budget: { monthly_usd: 1, confirm_over_usd: 0.25 } }
    const cap = lib.checkBudget({ lines, by: 'unit:b', estUsd: 0.2, unitBudget: 5, config, now })
    expect(cap).toMatchObject({ ok: false, spent_this_month: 0.9 })
    expect(cap.reason).toMatch(/monthly cap/)
    expect(lib.checkBudget({ lines, by: 'unit:b', estUsd: 0.1, unitBudget: 5, config, now }).ok).toBe(true)
    // above the confirm threshold: only a stated unit budget approves it
    expect(lib.checkBudget({ lines: [], by: 'unit:b', estUsd: 0.3, unitBudget: null, config, now }).reason).toMatch(/confirm threshold/)
    expect(lib.checkBudget({ lines: [], by: 'unit:b', estUsd: 0.3, unitBudget: 0.5, config, now }).ok).toBe(true)
  })

  it('gates Codex on the world config', () => {
    expect(lib.codexEnabled({})).toBe(false)
    expect(lib.codexEnabled({ providers: { codex: { enabled: false } } })).toBe(false)
    expect(lib.codexEnabled({ providers: { codex: { enabled: true } } })).toBe(true)
    expect(lib.codexEnabled({ providers: { codex: true } })).toBe(true)
  })

  it('writes provenance mirrored by asset path, never for files outside the world or in .genio/', () => {
    const world = makeWorld()
    const w = lib.openWorld(world)
    const asset = path.join(world, 'Assets', 'Gen', 'a.png')
    fs.mkdirSync(path.dirname(asset), { recursive: true })
    fs.writeFileSync(asset, 'png')
    expect(lib.writeProvenance(w, asset, { provider: 'fal' })).toBe('.genio/provenance/Assets/Gen/a.png.json')
    expect(readJson(path.join(world, '.genio', 'provenance', 'Assets', 'Gen', 'a.png.json'))).toEqual({
      schema: 'genio.provenance.v1', path: 'Assets/Gen/a.png', sha256: sha(asset), provider: 'fal'
    })
    const outside = path.join(tmp, 'b.png')
    fs.writeFileSync(outside, 'png')
    expect(lib.writeProvenance(w, outside, { provider: 'fal' })).toBeNull()
    expect(lib.writeProvenance(w, path.join(world, '.genio', 'fal', 'x.png'), { provider: 'fal' })).toBeNull()
  })

  it('refuses a broken config instead of ignoring its budget', () => {
    const world = makeWorld()
    fs.writeFileSync(path.join(world, '.genio', 'fal', 'config.json'), '{ "budget": ')
    expect(() => lib.openWorld(world)).toThrow(/not valid JSON/)
    fs.writeFileSync(path.join(world, '.genio', 'fal', 'config.json'), '{ "budget": { "monthly_usd": "lots" } }')
    expect(() => lib.openWorld(world)).toThrow(/monthly_usd/)
  })
})

describe('fal.mjs --world', () => {
  let server: http.Server
  let base = ''
  const posts: { url: string; body: any }[] = []

  beforeEach(async () => {
    posts.length = 0
    server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (d) => (raw += d))
      req.on('end', () => {
        const json = (code: number, body: unknown): void => {
          res.writeHead(code, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(body))
        }
        if (req.url === '/files/out.png') {
          res.writeHead(200, { 'Content-Type': 'image/png' })
          res.end(Buffer.from([137, 80, 78, 71, 1, 2, 3]))
          return
        }
        if (req.headers.authorization !== `Key ${KEY}`) return json(401, { detail: 'no key' })
        if (req.method === 'GET' && req.url?.startsWith('/v1/models/pricing?')) {
          return json(200, { prices: [{ endpoint_id: 'fal-ai/test/model', unit_price: 0.03, unit: 'image', currency: 'USD' }] })
        }
        if (req.method === 'POST' && req.url === '/queue/fal-ai/test/model') {
          posts.push({ url: req.url, body: JSON.parse(raw) })
          const r = `${base}/queue/fal-ai/test/requests/r1`
          return json(200, { request_id: 'r1', status_url: `${r}/status`, response_url: r, cancel_url: `${r}/cancel` })
        }
        if (req.url === '/queue/fal-ai/test/requests/r1/status') return json(200, { status: 'COMPLETED' })
        if (req.url === '/queue/fal-ai/test/requests/r1') return json(200, { images: [{ url: `${base}/files/out.png`, content_type: 'image/png', file_name: 'out.png' }], seed: 7 })
        json(404, {})
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterEach(() => new Promise<void>((r) => server.close(() => r())))

  const CONFIG = {
    schema: 'genio.fal-config.v1',
    folders: { image: 'Assets/Gen' },
    budget: { monthly_usd: 20, confirm_over_usd: 0.5 },
    defaults: { 'fal-ai/test/model': { output_format: 'png' } }
  }
  const RECIPES = [{ id: 'icon', label: 'UI icon', endpoint: 'fal-ai/test/model', prompt_template: '{subject}, flat game UI icon', input: { aspect_ratio: '1:1' }, save_to: 'image' }]
  const env = (): Record<string, string> => ({ FAL_KEY: KEY, GENIO_FAL_TEST_BASE: base, GENIO_TASK_ID: 't-x1' })

  it('merges defaults and the recipe, logs spend, writes provenance, and never edits config or recipes', async () => {
    const world = makeWorld(CONFIG, RECIPES)
    const before = [fs.readFileSync(path.join(world, '.genio', 'fal', 'config.json')), fs.readFileSync(path.join(world, '.genio', 'fal', 'recipes.json'))]
    const receipt = path.join(tmp, 'scratch', 'sword.job.json')
    const r = await runNode(FAL, ['run', '--world', world, '--recipe', 'icon', '--json', '{"prompt":"a sword"}', '--units', '2', '--budget', '1', '--receipt', receipt, '--name', 'sword'], env())
    expect(r.stderr).not.toContain(KEY)
    expect(r.code).toBe(0)
    expect(posts.map((p) => p.body)).toEqual([{ output_format: 'png', aspect_ratio: '1:1', prompt: 'a sword' }])

    const asset = path.join(world, 'Assets', 'Gen', 'sword.png')
    expect(fs.existsSync(asset)).toBe(true)
    const prov = readJson(path.join(world, '.genio', 'provenance', 'Assets', 'Gen', 'sword.png.json'))
    expect(prov).toMatchObject({
      schema: 'genio.provenance.v1',
      path: 'Assets/Gen/sword.png',
      sha256: sha(asset),
      provider: 'fal',
      endpoint: 'fal-ai/test/model',
      request_id: 'r1',
      input: { output_format: 'png', aspect_ratio: '1:1', prompt: 'a sword' },
      seed: 7,
      price: { unit: 'image', unit_price_usd: 0.03, estimated_usd: 0.06 },
      recipe: 'icon',
      derived_from: [],
      by: 'unit:t-x1'
    })
    expect(prov.price.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const spend = readLines(path.join(world, '.genio', 'spend.jsonl'))
    expect(spend).toHaveLength(1)
    expect(spend[0]).toMatchObject({ provider: 'fal', endpoint: 'fal-ai/test/model', request_id: 'r1', units: 2, unit: 'image', est_usd: 0.06, by: 'unit:t-x1' })
    expect(spend[0].t).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(fs.readFileSync(receipt, 'utf8')).not.toContain(KEY)
    expect([fs.readFileSync(path.join(world, '.genio', 'fal', 'config.json')), fs.readFileSync(path.join(world, '.genio', 'fal', 'recipes.json'))]).toEqual(before)

    // resuming the receipt is not another paid call: no new spend line
    const again = await runNode(FAL, ['run', '--world', world, '--recipe', 'icon', '--json', '{"prompt":"a sword"}', '--units', '2', '--budget', '1', '--receipt', receipt, '--name', 'sword'], env())
    expect(again.code).toBe(0)
    expect(posts).toHaveLength(1)
    expect(readLines(path.join(world, '.genio', 'spend.jsonl'))).toHaveLength(1)
  })

  it('stops at the brief budget before submitting', async () => {
    const world = makeWorld(CONFIG, RECIPES)
    const ledger = path.join(world, '.genio', 'spend.jsonl')
    fs.writeFileSync(ledger, JSON.stringify({ t: new Date().toISOString(), provider: 'fal', est_usd: 0.95, by: 'unit:t-x1' }) + '\n')
    const receipt = path.join(tmp, 'scratch', 'b.job.json')
    const r = await runNode(FAL, ['run', '--world', world, '--endpoint', 'fal-ai/test/model', '--json', '{"prompt":"x"}', '--units', '2', '--budget', '1', '--receipt', receipt, '--kind', 'image'], env())
    expect(r.code).toBe(6)
    expect(r.stderr).toMatch(/hard stop/)
    expect(r.stderr).toMatch(/needs-decision/)
    expect(posts).toHaveLength(0)
    expect(fs.existsSync(receipt)).toBe(false)
    expect(readLines(ledger)).toHaveLength(1)
  })

  it('stops at the world monthly cap and above the confirm threshold without a brief budget', async () => {
    const world = makeWorld({ ...CONFIG, budget: { monthly_usd: 0.05 } }, RECIPES)
    const args = (name: string, extra: string[]): string[] => ['submit', '--world', world, '--endpoint', 'fal-ai/test/model', '--json', '{"prompt":"x"}', '--receipt', path.join(tmp, `${name}.job.json`), ...extra]
    const cap = await runNode(FAL, args('cap', ['--units', '2', '--budget', '5']), env())
    expect(cap.code).toBe(6)
    expect(cap.stderr).toMatch(/monthly cap/)

    const world2 = path.join(tmp, 'world')
    fs.writeFileSync(path.join(world2, '.genio', 'fal', 'config.json'), JSON.stringify({ ...CONFIG, budget: { confirm_over_usd: 0.05 } }))
    const confirm = await runNode(FAL, args('confirm', ['--units', '2']), env())
    expect(confirm.code).toBe(6)
    expect(confirm.stderr).toMatch(/confirm threshold/)
    expect(posts).toHaveLength(0)
  })

  it('needs a cost estimate in world mode', async () => {
    const world = makeWorld(CONFIG, RECIPES)
    const r = await runNode(FAL, ['submit', '--world', world, '--endpoint', 'fal-ai/test/model', '--json', '{"prompt":"x"}', '--receipt', path.join(tmp, 'n.job.json')], env())
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/--units/)
    expect(posts).toHaveLength(0)
  })

  it('applies the same hard stop outside a world against --ledger', async () => {
    const ledger = path.join(tmp, 'scratch', 'spend.jsonl')
    const args = (n: string): string[] => ['submit', '--endpoint', 'fal-ai/test/model', '--json', '{"prompt":"x"}', '--receipt', path.join(tmp, `${n}.job.json`), '--est-usd', '0.6', '--budget', '1', '--ledger', ledger]
    expect((await runNode(FAL, args('one'), env())).code).toBe(0)
    const two = await runNode(FAL, args('two'), env())
    expect(two.code).toBe(6)
    expect(posts).toHaveLength(1)
    expect(readLines(ledger)).toMatchObject([{ provider: 'fal', est_usd: 0.6, by: 'unit:t-x1' }])
    expect((await runNode(FAL, ['submit', '--endpoint', 'fal-ai/test/model', '--json', '{}', '--receipt', 'z.job.json', '--budget', '1'], env())).code).toBe(2)
  })

  it('summarises the world and fills recipes without a key or network', async () => {
    const world = makeWorld({ ...CONFIG, providers: { codex: { enabled: true } } }, RECIPES)
    fs.writeFileSync(path.join(world, '.genio', 'spend.jsonl'), JSON.stringify({ t: new Date().toISOString(), provider: 'fal', est_usd: 0.25, by: 'unit:t-x1' }) + '\n')
    const w = await runNode(FAL, ['world', '--world', world, '--budget', '1'], { GENIO_TASK_ID: 't-x1' })
    expect(w.code).toBe(0)
    expect(JSON.parse(w.stdout)).toMatchObject({
      config: true,
      folders: { image: 'Assets/Gen' },
      budget: { monthly_usd: 20, spent_this_month: 0.25, remaining_this_month: 19.75, you: 'unit:t-x1', spent_by_you: 0.25, your_remaining_usd: 0.75 },
      recipes: [{ id: 'icon', endpoint: 'fal-ai/test/model', save_to: 'image', folder: 'Assets/Gen' }],
      providers: { codex: true }
    })
    const r = await runNode(FAL, ['recipe', '--world', world, '--id', 'icon', '--subject', 'a sword'], {})
    expect(JSON.parse(r.stdout)).toMatchObject({ prompt: 'a sword, flat game UI icon', input: { output_format: 'png', aspect_ratio: '1:1' }, folder: 'Assets/Gen' })
    expect((await runNode(FAL, ['recipe', '--world', world, '--id', 'nope'], {})).code).toBe(2)
  })
})

describe('codex-image.mjs', () => {
  const FAKE = path.join(FIXTURES, 'fake-codex.mjs')
  const setup = (): { codexHome: string; scratch: string; env: Record<string, string> } => {
    const codexHome = path.join(tmp, 'codex')
    fs.mkdirSync(codexHome)
    const scratch = path.join(tmp, 'genio', 'data', 'codex-image')
    return { codexHome, scratch, env: { GENIO_CODEX_BIN: FAKE, CODEX_HOME: codexHome, GENIO_CODEX_IMAGE_SCRATCH: scratch, GENIO_TASK_ID: 't-c1' } }
  }
  const ENABLED = { schema: 'genio.fal-config.v1', providers: { codex: { enabled: true } } }

  it('runs only when the world enabled Codex, or with an explicit --no-world', async () => {
    const { codexHome, env } = setup()
    const out = path.join(tmp, 'a.png')
    const none = await runNode(CODEX_IMAGE, ['--prompt', 'a', '--out', out], env)
    expect(none.code).toBe(2)
    expect(none.stderr).toMatch(/--no-world/)
    const world = makeWorld({ schema: 'genio.fal-config.v1' })
    const off = await runNode(CODEX_IMAGE, ['--world', world, '--prompt', 'a', '--out', path.join(world, 'a.png')], env)
    expect(off.code).toBe(3)
    expect(off.stderr).toMatch(/not enabled for this world/)
    fs.rmSync(path.join(world, '.genio', 'fal', 'config.json'))
    const noConfig = await runNode(CODEX_IMAGE, ['--world', world, '--prompt', 'a', '--out', path.join(world, 'a.png')], env)
    expect(noConfig.code).toBe(3)
    expect(fs.existsSync(path.join(codexHome, 'fake-args.json'))).toBe(false)
    expect(fs.existsSync(path.join(world, '.genio', 'spend.jsonl'))).toBe(false)
  })

  it('batches images in one exec, copies them from the rollout and records provenance and spend', async () => {
    const { codexHome, scratch, env } = setup()
    const world = makeWorld(ENABLED)
    const before = fs.readFileSync(path.join(world, '.genio', 'fal', 'config.json'))
    const a = path.join(world, 'Art', 'a.png')
    const b = path.join(world, 'Art', 'b.png')
    const ref = path.join(world, 'Art', 'ref.png')
    fs.mkdirSync(path.dirname(ref), { recursive: true })
    fs.writeFileSync(ref, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const r = await runNode(CODEX_IMAGE, ['--world', world, '--transparent', '--prompt', 'a red gem', '--out', a, '--prompt', 'a blue gem', '--out', b, '--ref', ref], env)
    expect(r.code).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out).toMatchObject({ provider: 'codex', plan: 'chatgpt', warning: null, spend_lines: 2, plan_meter: { plan_type: 'pro', used_percent: 5, used_percent_before: 1 } })
    expect(out.images.map((i: any) => i.ok)).toEqual([true, true])

    const call = readJson(path.join(codexHome, 'fake-args.json'))
    expect(call.args.slice(0, 1)).toEqual(['exec'])
    expect(call.args).toEqual(expect.arrayContaining(['--skip-git-repo-check', '-s', 'workspace-write', '-c', 'model_reasoning_effort="low"', '--json', '-i', ref]))
    expect(path.relative(scratch, call.cwd).startsWith('..')).toBe(false)
    expect(call.args[call.args.indexOf('-C') + 1]).toBe(call.cwd)
    expect(call.prompt).toMatch(/Item 1 \(transparent background: yes\):\na red gem/)
    expect(call.prompt).toMatch(/Item 2 \(transparent background: yes\):\na blue gem/)

    for (const [file, prompt] of [[a, 'a red gem'], [b, 'a blue gem']] as const) {
      expect(fs.readFileSync(file).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      const rel = path.relative(world, file).split(path.sep).join('/')
      const prov = readJson(path.join(world, '.genio', 'provenance', `${rel}.json`))
      expect(prov).toMatchObject({
        schema: 'genio.provenance.v1',
        path: rel,
        sha256: sha(file),
        provider: 'codex',
        endpoint: 'codex/image_gen',
        thread_id: out.thread_id,
        input: { prompt, transparent_background: true, refs: ['Art/ref.png'] },
        revised_prompt: `revised: ${prompt}`,
        price: { estimated_usd: 0, plan: 'chatgpt' },
        derived_from: ['Art/ref.png'],
        by: 'unit:t-c1'
      })
    }
    const spend = readLines(path.join(world, '.genio', 'spend.jsonl'))
    expect(spend).toHaveLength(2)
    for (const l of spend) expect(l).toMatchObject({ provider: 'codex', what: 'image_gen', est_usd: 0, plan: 'chatgpt', thread_id: out.thread_id, by: 'unit:t-c1' })
    expect(fs.readFileSync(path.join(world, '.genio', 'fal', 'config.json'))).toEqual(before)
  })

  it('warns when the plan meter passes the threshold and works outside a world with --no-world', async () => {
    const { env } = setup()
    const out = path.join(tmp, 'out', 'x.png')
    const r = await runNode(CODEX_IMAGE, ['--no-world', '--prompt', 'x', '--out', out, '--warn-at', '90'], { ...env, FAKE_CODEX_USED: '92' })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).warning).toMatch(/92%/)
    expect(r.stderr).toMatch(/WARNING/)
    expect(fs.existsSync(out)).toBe(true)
    expect(fs.existsSync(path.join(tmp, '.genio'))).toBe(false)
  })

  it('reports a run with no image as a failure and never runs Codex inside the world', async () => {
    const { env } = setup()
    const world = makeWorld(ENABLED)
    const r = await runNode(CODEX_IMAGE, ['--world', world, '--prompt', 'x', '--out', path.join(world, 'x.png')], { ...env, FAKE_CODEX_MODE: 'no-image' })
    expect(r.code).toBe(4)
    expect(JSON.parse(r.stdout).images[0]).toMatchObject({ ok: false })
    expect(fs.existsSync(path.join(world, '.genio', 'spend.jsonl'))).toBe(false)

    const inside = await runNode(CODEX_IMAGE, ['--world', world, '--prompt', 'x', '--out', path.join(world, 'y.png'), '--scratch', path.join(world, 'tmp')], env)
    expect(inside.code).toBe(2)
    expect(inside.stderr).toMatch(/overlaps the world/)
    expect(fs.existsSync(path.join(world, 'tmp'))).toBe(false)
  })
})
