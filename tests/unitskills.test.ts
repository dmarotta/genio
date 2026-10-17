import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderBrief, type BriefInput } from '../src/main/brief'
import { assertIsolatedHomes } from './support/isolated-homes.mjs'
import { grantEnv } from './support/spend-grant'
import { blenderSkillDir, codexImageSkillDir, falSkillDir, genioUnityScript, installUnitPlugin, MODELLER_API_CARD, modellerBrief, modellerScript, unitLaunchExtras, unitPluginDir, unitPluginSource, unitToolsBrief, unitySkillDir } from '../src/main/unitskills'

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = path.join(unitPluginSource(APP_ROOT), 'skills', 'fal', 'scripts', 'fal.mjs')
const KEY = 'fal-test-key-0000:abcdefabcdefabcdef'
const fwd = (p: string): string => p.replace(/\\/g, '/')

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-unitskills-'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const listFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name)).sort()

describe('unit launch extras', () => {
  const pluginDir = path.join('C:\\genio', 'skills', 'genio')

  it('passes the FAL key only as FAL_KEY when one is set', () => {
    const x = unitLaunchExtras('claude', { pluginDir, falKey: `  ${KEY}\n` })
    expect(x.env.FAL_KEY).toBe(KEY)
    expect(x.args).toEqual(['--plugin-dir', pluginDir])
    expect(x.args.join(' ')).not.toContain(KEY)
    expect(Object.entries(x.env).filter(([, v]) => v.includes(KEY)).map(([k]) => k)).toEqual(['FAL_KEY'])
  })

  it('sets no FAL_KEY when the key is absent or blank', () => {
    for (const falKey of [undefined, '', '   ']) {
      const x = unitLaunchExtras('claude', { pluginDir, falKey })
      expect(x.env).not.toHaveProperty('FAL_KEY')
      expect(x.env.GENIO_FAL_SKILL).toBe(fwd(falSkillDir(pluginDir)))
    }
  })

  it('gives the plugin dir only to Claude Code, the skill path to every runtime', () => {
    const codex = unitLaunchExtras('codex', { pluginDir, falKey: KEY })
    expect(codex.args).toEqual([])
    expect(codex.env).toEqual({ GENIO_UNITY_SKILL: 'C:/genio/skills/genio/skills/unity', GENIO_UNITY: 'C:/genio/skills/genio/skills/unity/scripts/genio-unity.mjs', GENIO_ASSETS_SKILL: 'C:/genio/skills/genio/skills/assets', GENIO_UTHANA_SKILL: 'C:/genio/skills/genio/skills/uthana', GENIO_SOUND_SKILL: 'C:/genio/skills/genio/skills/sound', GENIO_BLENDER_SKILL: fwd(blenderSkillDir(pluginDir)), GENIO_FAL_SKILL: fwd(falSkillDir(pluginDir)), GENIO_IMAGEGEN_CODEX_SKILL: fwd(codexImageSkillDir(pluginDir)), FAL_KEY: KEY })
    expect(unitLaunchExtras('claude', { falKey: KEY })).toEqual({ args: [], env: { FAL_KEY: KEY } })
  })

  it('points the Codex image helper at a scratch folder in Genio data', () => {
    const x = unitLaunchExtras('claude', { pluginDir, dataDir: path.join('C:\\genio', 'data') })
    expect(x.env.GENIO_BLENDER_SCRATCH).toBe('C:/genio/data/blender')
    expect(x.env.GENIO_CODEX_IMAGE_SCRATCH).toBe('C:/genio/data/codex-image')
    expect(x.env.GENIO_IMAGEGEN_CODEX_SKILL).toBe('C:/genio/skills/genio/skills/imagegen-codex')
  })

  it('uses the unit data folder for Blender logs', () => {
    const x = unitLaunchExtras('codex', { pluginDir, dataDir: 'C:/genio/data', taskDataDir: 'C:/genio/data/unit-a' })
    expect(x.env.GENIO_BLENDER_SCRATCH).toBe('C:/genio/data/unit-a/blender')
    expect(x.env.GENIO_MODELLER_DATA).toBe('C:/genio/data/unit-a/modeller')
    expect(unitToolsBrief(pluginDir)).toContain('skills/blender/SKILL.md')
    // Modeller steps belong to a unit: without its data folder there is no place for them
    expect(unitLaunchExtras('codex', { pluginDir, dataDir: 'C:/genio/data' }).env).not.toHaveProperty('GENIO_MODELLER_DATA')
  })
})

describe('installUnitPlugin', () => {
  it('installs into the base, outside the world tree, and leaves the world untouched', () => {
    const world = path.join(tmp, 'home', 'worktrees', 'game', 'unit-a1')
    fs.mkdirSync(world, { recursive: true })
    fs.writeFileSync(path.join(world, 'README.md'), 'game\n')
    const before = listFiles(world)
    const target = unitPluginDir(path.join(tmp, 'home'))

    installUnitPlugin(unitPluginSource(APP_ROOT), target, [world])

    expect(listFiles(world)).toEqual(before)
    expect(fwd(path.relative(world, target)).startsWith('../')).toBe(true)
    expect(fs.existsSync(path.join(target, '.claude-plugin', 'plugin.json'))).toBe(true)
    const skill = fs.readFileSync(path.join(falSkillDir(target), 'SKILL.md'), 'utf8')
    expect(skill).toMatch(/^---\nname: fal\n/)
    expect(skill).not.toContain('{{SKILL_DIR}}')
    expect(skill).toContain(`${fwd(falSkillDir(target))}/scripts/fal.mjs`)
    expect(skill).toMatch(/budget/i)
    expect(skill).toContain('Settings → Accounts')
    expect(fs.existsSync(path.join(falSkillDir(target), 'scripts', 'fal.mjs'))).toBe(true)
    expect(skill).toContain('https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=')
    const codexSkill = fs.readFileSync(path.join(codexImageSkillDir(target), 'SKILL.md'), 'utf8')
    expect(codexSkill).toMatch(/^---\nname: imagegen-codex\n/)
    expect(codexSkill).toContain('uses your ChatGPT plan')
    expect(codexSkill).toContain(`${fwd(codexImageSkillDir(target))}/scripts/codex-image.mjs`)
    expect(fs.existsSync(path.join(target, 'lib', 'genio-world.mjs'))).toBe(true)
    const unitySkill = fs.readFileSync(path.join(unitySkillDir(target), 'SKILL.md'), 'utf8')
    expect(unitySkill).toMatch(/^---\nname: unity\n/)
    expect(unitySkill).toContain(`node "${fwd(genioUnityScript(target))}" <verb>`)
    expect(fs.existsSync(genioUnityScript(target))).toBe(true)
    expect(fs.existsSync(path.join(target, 'lib', 'unity-editors.mjs'))).toBe(true)
    // the Play helper stays (genio-unity runs it), its retired skill page does not
    expect(fs.existsSync(path.join(target, 'skills', 'play', 'scripts', 'play.mjs'))).toBe(true)
    fs.writeFileSync(path.join(target, 'skills', 'play', 'SKILL.md'), 'left by an older install')
    // idempotent refresh
    expect(() => installUnitPlugin(unitPluginSource(APP_ROOT), target, [world])).not.toThrow()
    expect(fs.existsSync(path.join(target, 'skills', 'play', 'SKILL.md'))).toBe(false)
  })

  it('refuses a target inside a world', () => {
    const world = path.join(tmp, 'world')
    fs.mkdirSync(world)
    const target = path.join(world, '.claude', 'plugins', 'genio')
    expect(() => installUnitPlugin(unitPluginSource(APP_ROOT), target, [world])).toThrow(/overlaps the project/)
    expect(fs.existsSync(path.join(world, '.claude'))).toBe(false)
  })
})

describe('brief tools section', () => {
  const base: BriefInput = {
    taskId: 't-a1',
    kind: 'ship',
    project: 'game',
    worktree: 'C:\\genio\\worktrees\\game\\t-a1',
    branch: 'genio/t-a1',
    baseBranch: 'main',
    intent: 'Make a jingle',
    statusFile: 'C:\\genio\\state\\t-a1.status',
    inboxDir: 'C:\\genio\\state\\t-a1.inbox',
    taskDataDir: 'C:\\genio\\data\\t-a1'
  }

  it('points at the skill by path, before the definition of done', () => {
    const b = renderBrief({ ...base, tools: unitToolsBrief('C:\\genio\\skills\\genio') })
    expect(b).toContain('C:/genio/skills/genio/skills/fal/SKILL.md')
    expect(b.indexOf('# Tools')).toBeGreaterThan(b.indexOf('# Engine notes'))
    expect(b.indexOf('# Tools')).toBeLessThan(b.indexOf('# Definition of done'))
    // Spending: none without the player's approval, how to ask, and Codex images are free.
    expect(b).toContain("no paid call (FAL, Uthana, the Sound Studio's FAL steps, any paid provider) runs without the player's approval")
    expect(b).toContain('You start with no spend grant (USD 0).')
    expect(b).toContain('needs-decision [key=spend]')
    expect(b).toContain('`{"spend_usd": <amount>')
    expect(b).toContain('Codex images on the ChatGPT plan are not a spend')
    expect(b).not.toMatch(/--budget/)
    expect(unitToolsBrief('C:\\genio\\skills\\genio', undefined, 0.5)).toContain('The player has approved USD 0.50 for you so far: that is your spend grant.')
    expect(b).toContain('--world')
    expect(b).toContain('C:/genio/skills/genio/skills/imagegen-codex/SKILL.md')
    // Codex is the default for images, FAL the specialist (listed after it)
    expect(b).toContain("Images (default): Codex images on the player's ChatGPT plan, on in every project unless it opted out")
    expect(b.indexOf('imagegen-codex/SKILL.md')).toBeLessThan(b.indexOf('fal/SKILL.md'))
    expect(b).toMatch(/FAL\.ai \(specific needs: seamless\/PBR textures, 3D, audio/)
    expect(b).not.toMatch(/only when the world enabled/)
    expect(renderBrief(base)).not.toContain('# Tools')
    // Unity goes through genio-unity only; the retired Play page and flag are gone.
    expect(b).toContain('node "C:/genio/skills/genio/skills/unity/scripts/genio-unity.mjs" <verb>')
    expect(b).not.toMatch(/skills\/play\/SKILL\.md|--world-path|GENIO_PLAY_/)
  })

  it('adds the Modeller working rules only to Modeller units, after Tools', () => {
    const plugin = 'C:\\genio\\skills\\genio'
    const modeller = modellerBrief(plugin, base.taskDataDir)
    const b = renderBrief({ ...base, tools: unitToolsBrief(plugin), modeller })
    expect(b.indexOf('# Modeller')).toBeGreaterThan(b.indexOf('# Tools'))
    expect(b.indexOf('# Modeller')).toBeLessThan(b.indexOf('# Definition of done'))
    expect(b).toContain('node "C:/genio/skills/genio/skills/blender/scripts/modeller.mjs" step <model> <script.py>')
    expect(b).toContain('C:/genio/skills/genio/skills/blender/SKILL.md`, section "Modeller steps"')
    expect(b).toContain('`C:/genio/data/t-a1/modeller/`')
    expect(b).toMatch(/no MCP and no live Blender session/)
    // The text review comes first; the sheet only when the unit needs to see the model.
    expect(b).toMatch(/After every step, read its text `review`.*Open the review sheet PNG it prints .* only when you need to see/)
    expect(MODELLER_API_CARD).toMatch(/After each step read its `review` first.*Open the `sheet` only for shape, proportions and style/)
    expect(b).toMatch(/`--symmetry x` for a model mirrored left to right/)
    expect(b).toMatch(/Fix what is wrong before adding anything new/)
    expect(b).toMatch(/never a gate/)
    expect(b).toMatch(/docstring caption/)
    // One step per script, written and run in the same response; a small first step; batch only replays.
    expect(b).toMatch(/One step per script.*in the same response/)
    expect(b).toMatch(/first step is one small script that blocks out the main mass/)
    expect(b).toContain('node "C:/genio/skills/genio/skills/blender/scripts/modeller.mjs" batch <model> <script.py>...` only replays scripts that already exist')
    expect(b).toMatch(/Never build new steps with it/)
    expect(b).not.toMatch(/batches of \d/)
    expect(b).toMatch(/low-poly web model, bake at 1024 px/)
    // Paint is presets plus one joined bake, never a bake loop of the unit's own.
    expect(b).toMatch(/bake once with `p\.bake_maps\(\)`, never with your own bake loop/)
    expect(MODELLER_API_CARD).toMatch(/`p\.uv_atlas\(\)`.*`p\.camo\(mat, 'red'\|'woodland'\|'desert'\|'digital'\)`.*`p\.weathering\(mat.*`p\.bake_maps\(size=1024\)`/)
    // Helpers are written once, in lib.py, and the card names the ones units used to write themselves.
    expect(MODELLER_API_CARD).toMatch(/Write each helper of yours once, in `lib\.py` beside the step scripts: it runs before every step/)
    for (const helper of ['p.join(', 'p.drop(', 'p.mirror_pair(', 'p.ring(', 'p.loft(']) expect(MODELLER_API_CARD).toContain(helper)
    // The API card replaces reading the Python sources.
    expect(b).toContain(MODELLER_API_CARD)
    expect(b).toMatch(/never read `genio_step\.py`, `genio_parts\.py` or `modeller\.mjs`/)
    expect(MODELLER_API_CARD.length).toBeLessThan(2800)
    expect(renderBrief({ ...base, tools: unitToolsBrief(plugin) })).not.toContain('# Modeller')
  })

  it('installs the Modeller kernel and its skill section with the Blender skill', () => {
    const target = unitPluginDir(path.join(tmp, 'home'))
    installUnitPlugin(unitPluginSource(APP_ROOT), target, [])
    const skill = fs.readFileSync(path.join(blenderSkillDir(target), 'SKILL.md'), 'utf8')
    expect(skill).toContain('## Modeller steps')
    expect(skill).toContain(`node "${fwd(blenderSkillDir(target))}/scripts/modeller.mjs" init watchtower`)
    expect(skill).toMatch(/\| `scene\.render\.engine = 'BLENDER_EEVEE'` \| error \| ok \|/)
    // The skill carries the brief's API card word for word, and the same one-step loop.
    expect(skill).toContain(MODELLER_API_CARD)
    expect(skill).toMatch(/One step per script.*in the same response/)
    expect(skill).toMatch(/`batch <model>` replays scripts that already exist/)
    expect(skill).not.toMatch(/batches of \d/)
    expect(skill).toMatch(/1024 px textures/)
    expect(skill).toContain('**Paint and bake.**')
    expect(skill).toMatch(/`gpu=True` tries .*off by default because it competes with the player's game or editor/)
    for (const f of ['modeller.mjs', 'genio_step.py', 'genio_parts.py', 'blender.mjs', 'genio_bpy.py']) expect(fs.existsSync(path.join(blenderSkillDir(target), 'scripts', f))).toBe(true)
    expect(fwd(modellerScript(target))).toBe(`${fwd(blenderSkillDir(target))}/scripts/modeller.mjs`)
  })
})

interface Run {
  code: number
  stdout: string
  stderr: string
}

function runScript(args: string[], env: Record<string, string | undefined>, cwd = tmp): Promise<Run> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env }
  delete childEnv.FAL_KEY
  delete childEnv.GENIO_FAL_TEST_BASE
  Object.assign(childEnv, env)
  assertIsolatedHomes(childEnv)
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { cwd, env: childEnv }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0
      resolve({ code, stdout, stderr })
    })
  })
}

describe('fal.mjs helper', () => {
  it('reports a missing key clearly and makes no receipt', async () => {
    const r = await runScript(['check'], {})
    expect(r.code).toBe(3)
    expect(r.stderr).toMatch(/FAL key missing/)
    expect(r.stderr).toMatch(/Settings -> Accounts/)
    fs.writeFileSync(path.join(tmp, 'in.json'), '{"prompt":"x"}')
    const s = await runScript(['submit', '--endpoint', 'fal-ai/flux/dev', '--input', 'in.json', '--receipt', 'a.job.json', '--est-usd', '0.03', '--ledger', 'spend.jsonl'], grantEnv(path.join(tmp, 'grant'), 't-k1', 1))
    expect(s.code).toBe(3)
    expect(fs.existsSync(path.join(tmp, 'a.job.json'))).toBe(false)
  })

  it('confirms a key without printing it', async () => {
    const r = await runScript(['check'], { FAL_KEY: KEY })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ configured: true })
    expect(r.stdout + r.stderr).not.toContain(KEY)
  })

  describe('against a loopback FAL stand-in', () => {
    let server: http.Server
    let base = ''
    const seen: { method: string; url: string; auth?: string }[] = []

    beforeEach(async () => {
      seen.length = 0
      server = http.createServer((req, res) => {
        seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization })
        const json = (code: number, body: unknown): void => {
          res.writeHead(code, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(body))
        }
        const authed = req.headers.authorization === `Key ${KEY}`
        if (req.url === '/files/out.png') {
          res.writeHead(200, { 'Content-Type': 'image/png' })
          res.end(Buffer.from([137, 80, 78, 71, 1, 2, 3]))
          return
        }
        if (!authed) return json(401, { detail: 'no key' })
        if (req.method === 'POST' && req.url === '/queue/fal-ai/test/bad') return json(422, { detail: [{ msg: 'prompt too long' }] })
        if (req.method === 'POST' && req.url === '/queue/fal-ai/test/model') {
          const r = `${base}/queue/fal-ai/test/requests/r1`
          return json(200, { request_id: 'r1', status_url: `${r}/status`, response_url: r, cancel_url: `${r}/cancel`, queue_position: 0 })
        }
        if (req.url === '/queue/fal-ai/test/requests/r1/status') return json(200, { status: 'COMPLETED', metrics: { inference_time: 1.5 } })
        if (req.url === '/queue/fal-ai/test/requests/r1') {
          return json(200, { images: [{ url: `${base}/files/out.png`, content_type: 'image/png', file_name: 'out.png' }], seed: 7 })
        }
        json(404, {})
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    })
    afterEach(() => new Promise<void>((r) => server.close(() => r())))

    it('runs a model end to end, downloads unauthenticated, and resumes without resubmitting', async () => {
      fs.writeFileSync(path.join(tmp, 'hero.input.json'), JSON.stringify({ prompt: 'a knight' }))
      const args = ['run', '--endpoint', 'fal-ai/test/model', '--input', 'hero.input.json', '--receipt', 'art/hero.job.json', '--dir', 'art/out', '--name', 'hero', '--est-usd', '0.03', '--ledger', 'spend.jsonl']
      const env = { FAL_KEY: KEY, GENIO_FAL_TEST_BASE: base, ...grantEnv(path.join(tmp, 'grant'), 't-k1', 1) }
      const r = await runScript(args, env)
      expect(r.stderr).not.toContain(KEY)
      expect(r.code).toBe(0)
      expect(r.stdout).not.toContain(KEY)
      const out = JSON.parse(r.stdout)
      expect(out).toMatchObject({ request_id: 'r1', resumed: false, metrics: { inference_time: 1.5 } })
      const png = path.join(tmp, 'art', 'out', 'hero.png')
      expect(fs.readFileSync(png).subarray(0, 4)).toEqual(Buffer.from([137, 80, 78, 71]))
      const receipt = fs.readFileSync(path.join(tmp, 'art', 'hero.job.json'), 'utf8')
      expect(receipt).not.toContain(KEY)
      expect(JSON.parse(receipt)).toMatchObject({ state: 'completed', endpoint: 'fal-ai/test/model', submission: { request_id: 'r1' } })
      expect(fs.existsSync(path.join(tmp, 'art', 'hero.result.json'))).toBe(true)
      expect(seen.find((s) => s.url === '/files/out.png')?.auth).toBeUndefined()
      expect(seen.filter((s) => s.method === 'POST')).toHaveLength(1)

      const again = await runScript(args, env)
      expect(again.code).toBe(0)
      expect(JSON.parse(again.stdout)).toMatchObject({ resumed: true, request_id: 'r1' })
      expect(seen.filter((s) => s.method === 'POST')).toHaveLength(1)
    })

    it('records a rejected input and refuses to reuse its receipt', async () => {
      const env = { FAL_KEY: KEY, GENIO_FAL_TEST_BASE: base, ...grantEnv(path.join(tmp, 'grant'), 't-k1', 1) }
      const args = ['submit', '--endpoint', 'fal-ai/test/bad', '--json', '{"prompt":"x"}', '--receipt', 'bad.job.json', '--est-usd', '0.03', '--ledger', 'spend.jsonl']
      const r = await runScript(args, env)
      expect(r.code).toBe(4)
      expect(JSON.parse(fs.readFileSync(path.join(tmp, 'bad.job.json'), 'utf8'))).toMatchObject({ state: 'rejected' })
      const again = await runScript(args, env)
      expect(again.code).toBe(2)
      expect(again.stderr).toMatch(/already exists/)
      expect(seen.filter((s) => s.method === 'POST')).toHaveLength(1)
    })
  })
})
