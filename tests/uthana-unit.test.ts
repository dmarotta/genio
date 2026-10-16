import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UTHANA_BUILTINS, UTHANA_DEFAULTS, UTHANA_MODELS, UTHANA_PRICES_CHECKED, estimateUthana } from '../src/shared/uthana'
import { readUnitCharacters } from '../src/main/uthana-service'
import { unitLaunchExtras, unitPluginSource, unitToolsBrief } from '../src/main/unitskills'
import { assertIsolatedHomes } from './support/isolated-homes.mjs'
import { grantEnv } from './support/spend-grant'

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKILL = path.join(unitPluginSource(APP_ROOT), 'skills', 'uthana')
const SCRIPT = path.join(SKILL, 'scripts', 'uthana.mjs')
const KEY = 'uthana-test-key-7f3a9c0d1e2b4a5f'
const BASIC = `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`
const FBX = Buffer.from('Kaydara FBX Binary  \0motion-bytes')

interface Run {
  code: number
  stdout: string
  stderr: string
}

let tmp: string
let world: string
let data: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-uthana-unit-'))
  world = path.join(tmp, 'world')
  data = path.join(tmp, 'genio-data', 'uthana')
  fs.mkdirSync(path.join(world, '.genio', 'fal'), { recursive: true })
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function runScript(args: string[], env: Record<string, string | undefined> = {}): Promise<Run> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env }
  for (const k of ['UTHANA_API_KEY', 'GENIO_UTHANA_TEST_BASE', 'GENIO_UTHANA_DATA', 'GENIO_UTHANA_POLL_MS', 'GENIO_TASK_ID', 'GENIO_PROJECT', 'GENIO_ART_BIBLE', 'FAL_KEY', 'GENIO_SPEND_GRANT', 'GENIO_SPEND_KEY']) delete childEnv[k]
  Object.assign(childEnv, env)
  assertIsolatedHomes(childEnv)
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { cwd: world, env: childEnv }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ code, stdout, stderr })
    })
  })
}

const readJson = (p: string): any => JSON.parse(fs.readFileSync(p, 'utf8'))
const readLines = (p: string): any[] => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const spendLines = (): any[] => readLines(path.join(world, '.genio', 'spend.jsonl'))
const sha = (p: string): string => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

/** Every file under a folder, as text: nothing a unit writes may hold the key. */
function allText(dir: string): string {
  if (!fs.existsSync(dir)) return ''
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).map((e) => fs.readFileSync(path.join(e.parentPath, e.name), 'utf8')).join('\n')
}

describe('uthana.mjs (fake Uthana)', () => {
  let server: http.Server
  let cdn: http.Server
  let base = ''
  let cdnPort = 0
  const calls: { op: string; vars: any; auth?: string }[] = []
  const cdnAuth: (string | undefined)[] = []
  let jobPolls = 0
  let failNext: 'graphql' | null = null

  beforeEach(async () => {
    calls.length = 0
    cdnAuth.length = 0
    jobPolls = 0
    failNext = null
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (d: Buffer) => chunks.push(d))
      req.on('end', () => {
        const json = (code: number, body: unknown): void => {
          res.writeHead(code, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(body))
        }

        if (req.headers.authorization !== BASIC) return json(401, { errors: [{ message: 'bad key' }] })
        if (req.method === 'GET' && req.url?.startsWith('/motion/file/motion_viewer/')) {
          calls.push({ op: 'download', vars: req.url })
          res.writeHead(302, { Location: `http://127.0.0.1:${cdnPort}/cdn/motion.bin` })
          res.end()
          return
        }
        if (req.method !== 'POST' || req.url !== '/graphql') return json(404, {})
        const raw = Buffer.concat(chunks).toString('utf8')
        let q = ''
        let vars: any = {}
        if (String(req.headers['content-type']).startsWith('multipart/form-data')) {
          const ops = /name="operations"\r\n\r\n(.*?)\r\n--/s.exec(raw)?.[1] ?? '{}'
          ;({ query: q, variables: vars } = JSON.parse(ops))
          vars.fileName = /name="0"; filename="([^"]+)"/.exec(raw)?.[1]
        } else ({ query: q, variables: vars } = JSON.parse(raw))
        const op = /(?:mutation|query) (\w+)/.exec(q)?.[1] ?? 'anonymous'
        calls.push({ op, vars })
        if (failNext === 'graphql' && op !== 'GetJob') {
          failNext = null
          return json(200, { errors: [{ message: `prompt refused (key was ${KEY})` }] })
        }
        if (op === 'CreateTextToMotionJob') return json(200, { data: { create_text_to_motion_job: { job: { id: 'job1', status: 'RESERVED', est_processing_time: 20 } } } })
        if (op === 'GetJob') {
          jobPolls++
          return json(200, { data: { job: jobPolls < 2 ? { id: 'job1', status: 'READY', result: null } : { id: 'job1', status: 'FINISHED', result: JSON.stringify({ result: { id: 'mot1' } }) } } })
        }
        if (op === 'CreateTextToMotion') return json(200, { data: { create_text_to_motion: { motion: { id: 'mot2', name: vars.prompt } } } })
        if (op === 'CreateCharacter') return json(200, { data: { create_character: { character: { id: 'chGoblin1', name: vars.name }, auto_rig_confidence: 0.92, message: null } } })
        json(400, { errors: [{ message: `unknown op ${op}` }] })
      })
    })
    // the CDN a download redirects to: another origin, which must never get the key
    cdn = http.createServer((req, res) => {
      cdnAuth.push(req.headers.authorization)
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      res.end(FBX)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    await new Promise<void>((r) => cdn.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    cdnPort = (cdn.address() as { port: number }).port
  })
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    await new Promise<void>((r) => cdn.close(() => r()))
  })

  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    UTHANA_API_KEY: KEY, GENIO_UTHANA_TEST_BASE: base, GENIO_UTHANA_POLL_MS: '20', GENIO_UTHANA_DATA: data, GENIO_PROJECT: 'Knights', ...grantEnv(path.join(tmp, 'unit-data'), 't-uth1', 10), ...extra
  })
  const receipt = (name: string): string => path.join(tmp, 'scratch', `${name}.job.json`)
  const motionArgs = (name: string, more: string[] = []): string[] => [
    'motion', '--world', world, '--prompt', 'a tired soldier jogs forward', '--out', `Assets/Animations/${name}.fbx`, '--receipt', receipt(name), ...more
  ]

  it('stops at the budget before any paid call, counting what the unit already spent', async () => {
    const tooSmall = await runScript(motionArgs('jog', ['--budget', '0.5']), env())
    expect(tooSmall.code).toBe(6)
    expect(tooSmall.stderr).toMatch(/hard stop/)
    expect(JSON.parse(tooSmall.stderr).budget).toMatchObject({ est_usd: 0.8, unit_budget_usd: 0.5 })
    // 1.5 already spent by this unit: 0.8 more does not fit a 2.0 budget
    fs.writeFileSync(path.join(world, '.genio', 'spend.jsonl'), JSON.stringify({ t: new Date().toISOString(), provider: 'fal', est_usd: 1.5, by: 'unit:t-uth1' }) + '\n')
    const spent = await runScript(motionArgs('jog', ['--budget', '2']), env())
    expect(spent.code).toBe(6)
    expect(calls).toEqual([])
    expect(fs.existsSync(receipt('jog'))).toBe(false)
    expect(spendLines()).toHaveLength(1)
    // the project's monthly cap is a hard stop too
    fs.writeFileSync(path.join(world, '.genio', 'fal', 'config.json'), JSON.stringify({ schema: 'genio.fal-config.v1', budget: { monthly_usd: 2 } }))
    expect((await runScript(motionArgs('jog', ['--budget', '10']), env())).stderr).toMatch(/monthly cap/)
    expect(calls).toEqual([])
  })

  it('sends nothing without the player\'s grant and stops at its amount', async () => {
    const none = await runScript(motionArgs('jog'), env(grantEnv(path.join(tmp, 'no-grant'), 't-uth1')))
    expect(none.code).toBe(6)
    expect(none.stderr).toMatch(/No spend grant/)
    expect(none.stderr).toMatch(/needs-decision \[key=spend\]/)
    const rig = path.join(world, 'Rig.fbx')
    fs.writeFileSync(rig, 'rig')
    const upload = await runScript(['character', '--world', world, '--file', rig, '--receipt', receipt('rig')], env(grantEnv(path.join(tmp, 'no-grant'), 't-uth1')))
    expect(upload.code).toBe(6)
    expect(calls).toEqual([])
    expect(fs.existsSync(receipt('jog'))).toBe(false)
    // USD 0.80 approved: one 8 s motion (USD 0.80) fits, the next does not
    const small = (): Record<string, string> => env(grantEnv(path.join(tmp, 'small-grant'), 't-uth1', 0.8))
    const first = await runScript(motionArgs('jog'), small())
    expect(first.code, first.stderr).toBe(0)
    expect(spendLines()).toEqual([expect.objectContaining({ est_usd: 0.8, grant_usd: 0.8, approved_by: 'player' })])
    const second = await runScript(motionArgs('jog-2'), small())
    expect(second.code).toBe(6)
    expect(second.stderr).toMatch(/Spend grant exceeded/)
    expect(calls.filter((c) => c.op.startsWith('Create'))).toHaveLength(1)
  })

  it('estimates without a key or the network, with the same prices as Genio', async () => {
    const r = await runScript(['estimate', '--model', 'text-to-motion-3.0', '--length', '6'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ model: 'text-to-motion-3.0', est_usd: 0.6, seconds: 6, up_to: false })
    expect(JSON.parse((await runScript(['estimate', '--model', 'text-to-motion'])).stdout)).toMatchObject({ est_usd: 0.2, up_to: true })
    expect(JSON.parse((await runScript(['estimate', '--kind', 'character'])).stdout)).toMatchObject({ est_usd: 0.15, up_to: true })
    expect((await runScript(['estimate', '--model', 'text-to-motion-3.0', '--length', '4.5'])).code).toBe(2)
    expect((await runScript(['estimate', '--model', 'video-to-motion-2.0'])).stderr).toMatch(/report the needed motion/)
    expect(calls).toEqual([])
  })

  it('keeps its price snapshot and stock characters in step with Genio', async () => {
    const mod = (await import(pathToFileURL(SCRIPT).href)) as Record<string, any>
    expect(mod.PRICES_CHECKED).toBe(UTHANA_PRICES_CHECKED)
    for (const m of UTHANA_MODELS) {
      if (m.kind === 'character') expect(mod.AUTO_RIG_USD).toBe(m.unitPrice)
      else if (m.kind === 'text') {
        expect(mod.MODELS[m.id].unitPrice).toBe(m.unitPrice)
        expect(mod.MODELS[m.id].job).toBe(m.job)
        expect(mod.MODELS[m.id].defaultLength).toBe(UTHANA_DEFAULTS[m.id]?.length)
        for (const length of [undefined, 4, 7, 10]) {
          const ok = m.id !== 'text-to-motion' || length === undefined
          if (ok) expect(mod.estimateMotion(m.id, length).usd).toBeCloseTo(estimateUthana(m.id, { length }).usd!, 9)
        }
      }
    }
    expect(mod.STOCK).toEqual(UTHANA_BUILTINS)
    expect(mod.DEFAULT_MODEL).toBe('text-to-motion-3.0')
  })

  it('generates, waits, downloads with provenance and one spend line, and never writes the key', async () => {
    const r = await runScript(motionArgs('jog', ['--budget', '2', '--length', '6', '--fps', '30']), env())
    expect(r.code, r.stderr).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out).toMatchObject({ resumed: false, model: 'text-to-motion-3.0', motion_id: 'mot1', character_id: 'c43tbGks3crJ', format: 'fbx', est_usd: 0.6, provenance: '.genio/provenance/Assets/Animations/jog.fbx.json' })
    const file = path.join(world, 'Assets', 'Animations', 'jog.fbx')
    expect(fs.readFileSync(file)).toEqual(FBX)
    expect(calls.filter((c) => c.op === 'CreateTextToMotionJob')).toHaveLength(1)
    expect(calls.find((c) => c.op === 'CreateTextToMotionJob')!.vars).toEqual({ prompt: 'a tired soldier jogs forward', model: 'text-to-motion-3.0', character_id: 'c43tbGks3crJ', length: 6, fast: false })
    expect(calls.find((c) => c.op === 'download')!.vars).toBe('/motion/file/motion_viewer/c43tbGks3crJ/mot1/fbx/jog.fbx?fps=30')
    // the CDN a download redirects to never gets the key
    expect(cdnAuth).toEqual([undefined])

    expect(spendLines()).toEqual([expect.objectContaining({ provider: 'uthana', endpoint: 'uthana/text-to-motion-3.0', request_id: 'uthana:job1', units: 6, unit: 'seconds', est_usd: 0.6, by: 'unit:t-uth1' })])
    const prov = readJson(path.join(world, '.genio', 'provenance', 'Assets', 'Animations', 'jog.fbx.json'))
    expect(prov).toMatchObject({
      schema: 'genio.provenance.v1', path: 'Assets/Animations/jog.fbx', sha256: sha(file), provider: 'uthana', endpoint: 'uthana/text-to-motion-3.0', request_id: 'mot1',
      input: { prompt: 'a tired soldier jogs forward', length: 6, character_id: 'c43tbGks3crJ', character_name: 'Manny', job_id: 'job1', download: { format: 'fbx', fps: 30 } },
      price: { unit: 'seconds', unit_price_usd: 0.1, estimated_usd: 0.6, checked: UTHANA_PRICES_CHECKED }, recipe: null, derived_from: [], by: 'unit:t-uth1'
    })

    // the same command resumes the receipt: a free download, no new paid call, no new spend line
    const again = await runScript(motionArgs('jog', ['--budget', '2', '--overwrite']), env())
    expect(again.code, again.stderr).toBe(0)
    expect(JSON.parse(again.stdout)).toMatchObject({ resumed: true, motion_id: 'mot1' })
    expect(calls.filter((c) => c.op.startsWith('Create'))).toHaveLength(1)
    expect(spendLines()).toHaveLength(1)

    for (const text of [r.stdout, r.stderr, again.stdout, again.stderr, allText(world), allText(path.join(tmp, 'scratch')), allText(data)]) {
      expect(text).not.toContain(KEY)
      expect(text).not.toContain(BASIC.slice(6))
    }
  })

  it('applies the Art Bible Animation line and uses an immediate model with its length', async () => {
    fs.writeFileSync(path.join(world, '.genio', 'art-bible.md'), '# Art Bible: Test\n## Style\nChunky low-poly shapes.\n## Animation\nSnappy, exaggerated cartoon timing.\n')
    const r = await runScript(motionArgs('wave', ['--model', 'text-to-motion-bucmd', '--length', '3', '--character', 'Y Bot', '--budget', '1']), env())
    expect(r.code, r.stderr).toBe(0)
    const sent = calls.find((c) => c.op === 'CreateTextToMotion')!.vars
    expect(sent).toMatchObject({ model: 'text-to-motion-bucmd', character_id: 'cJM4ngRqXg83', length: 3 })
    expect(sent.prompt).toMatch(/^a tired soldier jogs forward\. .*Snappy, exaggerated cartoon timing/)
    expect(calls.some((c) => c.op === 'GetJob')).toBe(false)
    expect(spendLines()).toEqual([expect.objectContaining({ request_id: 'uthana:mot2', est_usd: 0.09 })])
    expect(readJson(path.join(world, '.genio', 'provenance', 'Assets', 'Animations', 'wave.fbx.json')).art_bible).toBeTruthy()
  })

  it('records a refusal as rejected with no spend line, and an uncertain call as spent', async () => {
    failNext = 'graphql'
    const r = await runScript(motionArgs('bad', ['--budget', '2']), env())
    expect(r.code).toBe(4)
    expect(r.stderr).not.toContain(KEY)
    expect(readJson(receipt('bad'))).toMatchObject({ state: 'rejected' })
    expect(spendLines()).toEqual([])
    // the receipt is never resubmitted
    expect((await runScript(motionArgs('bad', ['--budget', '2']), env())).code).toBe(2)
    expect(calls.filter((c) => c.op.startsWith('Create'))).toHaveLength(1)

    const down = await runScript(motionArgs('lost', ['--budget', '2']), env({ GENIO_UTHANA_TEST_BASE: 'http://127.0.0.1:1' }))
    expect(down.code).toBe(4)
    expect(readJson(receipt('lost'))).toMatchObject({ state: 'submission_unknown' })
    expect(spendLines()).toEqual([expect.objectContaining({ request_id: null, uncertain: true, est_usd: 0.8 })])
  })

  it('reports a missing key and refuses an existing file before any call', async () => {
    const c = await runScript(['check'])
    expect(c.code).toBe(3)
    expect(c.stderr).toMatch(/UTHANA_API_KEY/)
    const noKey = await runScript(motionArgs('jog', ['--budget', '2']), { GENIO_UTHANA_TEST_BASE: base, ...grantEnv(path.join(tmp, 'unit-data'), 't-uth1', 10) })
    expect(noKey.code).toBe(3)
    expect(fs.existsSync(receipt('jog'))).toBe(false)
    fs.mkdirSync(path.join(world, 'Assets', 'Animations'), { recursive: true })
    fs.writeFileSync(path.join(world, 'Assets', 'Animations', 'jog.fbx'), 'old')
    expect((await runScript(motionArgs('jog', ['--budget', '2']), env())).code).toBe(2)
    expect((await runScript(['motion', '--world', world, '--prompt', 'jump', '--out', 'Assets/a.glb', '--format', 'fbx', '--receipt', receipt('x')], env())).code).toBe(2)
    expect(calls).toEqual([])
    const ok = await runScript(['check'], { UTHANA_API_KEY: KEY })
    expect(ok.stdout).not.toContain(KEY)
    expect(JSON.parse(ok.stdout)).toMatchObject({ configured: true })
  })

  it('uploads a character once, then reuses it by project source and sha256', async () => {
    const rig = path.join(world, 'Assets', 'Models', 'Goblin.fbx')
    fs.mkdirSync(path.dirname(rig), { recursive: true })
    fs.writeFileSync(rig, 'goblin-rig-v1')
    const args = (name: string): string[] => ['character', '--world', world, '--file', 'Assets/Models/Goblin.fbx', '--receipt', receipt(name), '--budget', '1']
    const first = await runScript(args('goblin'), env())
    expect(first.code, first.stderr).toBe(0)
    expect(JSON.parse(first.stdout)).toMatchObject({ reused: false, est_usd: 0.15, character: { id: 'chGoblin1', world: 'Knights', source: 'Assets/Models/Goblin.fbx', sha256: sha(rig), autoRigConfidence: 0.92 } })
    expect(calls.filter((c) => c.op === 'CreateCharacter')).toEqual([expect.objectContaining({ vars: expect.objectContaining({ name: 'Goblin', auto_rig: true, fileName: 'Goblin.fbx' }) })])
    expect(spendLines()).toEqual([expect.objectContaining({ endpoint: 'uthana/auto-rig', request_id: 'uthana:chGoblin1', unit: 'rig', est_usd: 0.15 })])
    // Genio's own Uthana service sees what the unit uploaded
    expect(readUnitCharacters(data)).toEqual([expect.objectContaining({ id: 'chGoblin1', world: 'Knights', source: 'Assets/Models/Goblin.fbx' })])

    // same file: reused for free, no key, no call, no spend
    const again = await runScript(args('goblin-2'), { GENIO_UTHANA_DATA: data, GENIO_UTHANA_TEST_BASE: base })
    expect(again.code, again.stderr).toBe(0)
    expect(JSON.parse(again.stdout)).toMatchObject({ reused: true, character: { id: 'chGoblin1' } })
    expect(calls.filter((c) => c.op === 'CreateCharacter')).toHaveLength(1)
    expect(spendLines()).toHaveLength(1)

    // a record Genio's chat tool made is reused the same way
    const knight = path.join(world, 'Assets', 'Models', 'Knight.glb')
    fs.writeFileSync(knight, 'knight-rig')
    fs.writeFileSync(path.join(data, 'characters.json'), JSON.stringify([{ id: 'chKnight', name: 'Knight', world: 'Knights', source: 'Assets/Models/Knight.glb', sha256: sha(knight), createdAt: '2026-10-01T00:00:00Z' }]))
    const genio = await runScript(['character', '--world', world, '--file', knight, '--receipt', receipt('knight')], env())
    expect(JSON.parse(genio.stdout)).toMatchObject({ reused: true, character: { id: 'chKnight' } })

    // a changed file is a new upload; the motion then derives from its source
    fs.writeFileSync(rig, 'goblin-rig-v2')
    const changed = await runScript(args('goblin-3'), env())
    expect(JSON.parse(changed.stdout)).toMatchObject({ reused: false })
    const listed = JSON.parse((await runScript(['characters'], { GENIO_UTHANA_DATA: data })).stdout)
    expect(listed.uploaded.map((c: any) => c.id)).toEqual(expect.arrayContaining(['chGoblin1', 'chKnight']))
    const m = await runScript(motionArgs('goblin-walk', ['--character', 'chGoblin1', '--budget', '2']), env())
    expect(m.code, m.stderr).toBe(0)
    expect(readJson(path.join(world, '.genio', 'provenance', 'Assets', 'Animations', 'goblin-walk.fbx.json'))).toMatchObject({
      input: { character_id: 'chGoblin1', character_name: 'Goblin' }, derived_from: ['Assets/Models/Goblin.fbx']
    })
    expect(allText(data) + allText(world)).not.toContain(KEY)
  })

  it('stops a character upload at the budget', async () => {
    const rig = path.join(world, 'Rig.fbx')
    fs.writeFileSync(rig, 'rig')
    const r = await runScript(['character', '--world', world, '--file', rig, '--receipt', receipt('rig'), '--budget', '0.1'], env())
    expect(r.code).toBe(6)
    expect(calls).toEqual([])
    const free = await runScript(['character', '--world', world, '--file', rig, '--receipt', receipt('rig'), '--budget', '0.1', '--no-auto-rig'], env())
    expect(free.code, free.stderr).toBe(0)
    expect(spendLines()).toEqual([expect.objectContaining({ est_usd: 0 })])
  })
})

describe('Uthana key and data for units', () => {
  it('passes the Uthana key only as UTHANA_API_KEY, with Genio data and the project', () => {
    const pluginDir = 'C:\\genio\\skills\\genio'
    const x = unitLaunchExtras('claude', { pluginDir, uthanaKey: `  ${KEY}\n`, dataDir: 'C:\\genio\\data', project: 'Knights' })
    expect(x.env.UTHANA_API_KEY).toBe(KEY)
    expect(x.env.GENIO_UTHANA_DATA).toBe('C:/genio/data/uthana')
    expect(x.env.GENIO_PROJECT).toBe('Knights')
    expect(Object.entries(x.env).filter(([, v]) => v.includes(KEY)).map(([k]) => k)).toEqual(['UTHANA_API_KEY'])
    expect(x.args.join(' ')).not.toContain(KEY)
    expect(unitLaunchExtras('claude', { pluginDir, uthanaKey: '  ' }).env).not.toHaveProperty('UTHANA_API_KEY')
    const brief = unitToolsBrief(pluginDir)
    expect(brief).toContain('C:/genio/skills/genio/skills/uthana/scripts/uthana.mjs')
    expect(brief).not.toMatch(/no Uthana CLI/)
  })

  it('documents the helper in the uthana and assets skills', () => {
    const skill = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8')
    expect(skill).toContain('{{SKILL_DIR}}/scripts/uthana.mjs')
    expect(skill).toContain('UTHANA_API_KEY')
    const assets = fs.readFileSync(path.join(SKILL, '..', 'assets', 'SKILL.md'), 'utf8')
    expect(assets).not.toMatch(/no unit helper/)
    expect(assets).toContain('uthana.mjs')
  })
})
