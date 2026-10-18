import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { z } from 'zod'
import type { AppCtx } from '../src/main/services'
import type { GenioEvent, Project } from '../src/shared/types'
import type { FalRun } from '../src/shared/api'
import type { UthanaRun } from '../src/shared/uthana'
import type { Home } from '../src/main/home'
import { createInventoryService } from '../src/main/inventory'
import { AgentGeneration, agentGeneration, falGenerateShape, uthanaMotionShape } from '../src/main/agent-generation'
import { placementTarget, placeOutput } from '../src/main/asset-placement'
import { checkGenerationBudget, generationSpent, recordGenerationSpend } from '../src/main/generation-spend'
import { buildTools, createToolRegistry } from '../src/main/workspace-tools'
import { bus } from '../src/main/bus'
import { readSpend, sha256File, type Provenance } from '../src/main/fal-world'

vi.mock('../src/main/chat-imagegen', async importOriginal => {
  const original = await importOriginal<typeof import('../src/main/chat-imagegen')>()
  return { ...original, chatImageGen: (ctx: AppCtx, home: Home) => ({ chatDir: path.join(home.data, 'chat-images'), post: ctx.home(home.name).workspace.post }), generateChatImages: async (gen: any, a: unknown) => {
    (globalThis as { sentImageArgs?: unknown }).sentImageArgs = a
    fs.mkdirSync(gen.chatDir, { recursive: true })
    fs.writeFileSync(path.join(gen.chatDir, 'abc123-deadbeef.png'), 'image')
    gen.post({ text: '', images: [{ file: 'abc123-deadbeef.png', mediaType: 'image/png' }] })
    return { content: [] }
  } }
})

let dir: string, project: Project, ctx: AppCtx, service: AgentGeneration, runs: FalRun[], price: number
const write = (relative: string, value: unknown) => {
  const file = path.join(project.path, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
const provenance = (by = 'genio'): Omit<Provenance, 'sha256' | 'path'> => ({ schema: 'genio.provenance.v1', provider: 'fal', endpoint: 'fal-ai/test', request_id: 'request', input: { prompt: 'door' }, price: null, recipe: null, derived_from: [], by, created: new Date().toISOString() })
const args = (extra = {}) => ({ world: 'test', endpoint: 'fal-ai/test', input: { prompt: 'door creak' }, name: 'door.wav', player_words: 'make a door sound in test', ...extra })

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-generation-'))
  project = { name: 'test', path: path.join(dir, 'world'), engine: 'unity', engineRoot: 'Game' } as Project
  fs.mkdirSync(project.path)
  execFileSync('git', ['init', '-q'], { cwd: project.path, windowsHide: true })
  write('Game/Assets/Audio/SFX/door-01.wav', 'old')
  const home = { name: 'main', data: path.join(dir, 'data'), root: path.join(dir, 'home') } as Home
  const hc = { home, workspace: { post: vi.fn() }, wakes: { enqueue: vi.fn() } }
  runs = []; price = 0.1
  ctx = { appRoot: process.cwd(), main: hc, home: () => hc, projects: { get: (w: string) => w === 'test' ? project : undefined }, stats: { unlock: vi.fn() }, fal: {
    runs: () => runs,
    catalogue: () => ({ entries: [{ endpoint: 'fal-ai/test', output: 'audio' }], info: {}, jobs: [] }),
    model: async () => ({ endpoint: 'fal-ai/test', schema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string', minLength: 3 } } }, price: { unit: 'requests', unitPrice: price } }),
    run: vi.fn((req) => {
      const r: FalRun = { ...req, id: `fal-${runs.length}`, status: 'running', logs: [], outputs: [], estUsd: price, createdAt: new Date().toISOString() }
      recordGenerationSpend(ctx, 'fal', r, true); runs.push(r); return r
    }),
    save: vi.fn(async req => {
      const r = runs.find(r => r.id === req.runId)!
      return placeOutput({ project, source: r.outputs[req.output].localPath!, relative: req.folder + '/' + req.fileName, provenance: provenance(req.by), spend: { provider: 'fal', request_id: r.requestId, t: r.createdAt, est_usd: r.estUsd }, overwrite: req.overwrite })
    })
  }, uthana: { runs: () => [], generate: vi.fn(() => { throw new Error('mock provider unavailable') }), world: () => ({ characters: [] }), inspect: vi.fn(), upload: vi.fn() } } as unknown as AppCtx
  ctx.inventory = createInventoryService(() => ctx)
  service = new AgentGeneration(ctx)
})
afterEach(() => {
  service.stop(); ctx.inventory.stop(); fs.rmSync(dir, { recursive: true, force: true })
})

it('shows the quote card for every paid request, even USD 0.01, and binds approval to one chat and request', async () => {
  // an old confirm_over_usd no longer lets a paid request run without asking
  write('.genio/fal/config.json', { budget: { confirm_over_usd: 0.25 } })
  price = 0.01
  const card = await service.fal('main', args())
  expect(card.status).toBe('awaiting_approval')
  expect(card.approval).toBeUndefined()
  expect((ctx.main.workspace.post as Mock).mock.lastCall?.[0]).toMatchObject({ id: card.id, generation: { status: 'awaiting_approval', estimatedUsd: 0.01 } })
  price = 0.25
  expect((await service.fal('main', args())).status).toBe('awaiting_approval')
  expect(ctx.fal.run).not.toHaveBeenCalled()
  await expect(service.approve(card.id, 'another', 'yes')).rejects.toThrow('No such')
  await expect(service.approve(card.id, 'main', '')).rejects.toThrow('player')
  await expect(service.approve(card.id, 'main', 'yes', 'bot')).rejects.toThrow('Bot')
  await Promise.all([service.approve(card.id, 'main', 'yes', 'genio', 'card'), service.approve(card.id, 'main', 'yes', 'genio', 'card')])
  expect(ctx.fal.run).toHaveBeenCalledTimes(1)
  expect(runs[0].input).toEqual({ prompt: 'door creak' })
  expect(service.status(card.id, 'main').approval).toBe('approved by you on this card')
  // a request that costs nothing is not a spend: it runs without a card
  price = 0
  expect((await service.fal('main', args())).status).toBe('running')
})

it('approve_run takes only the player\'s own reply, sent after the quote appeared', async () => {
  price = 0.01
  const history = [{ id: 'm1', role: 'player', text: 'make a door sound in test, go ahead', ts: new Date(Date.now() - 60_000).toISOString() }]
  Object.assign(ctx.main.workspace, { history: () => history })
  const approveRun = createToolRegistry(() => ctx, ctx.main.home, 'genio').find(t => t.name === 'approve_run')!
  const card = await service.fal('main', args())
  // the request itself never approves its own quote
  expect((await approveRun.invoke({ run: card.id, player_words: 'make a door sound in test, go ahead' })).isError).toBe(true)
  expect((await approveRun.invoke({ run: card.id, player_words: 'yes, run it' })).isError).toBe(true)
  expect(ctx.fal.run).not.toHaveBeenCalled()
  history.push({ id: 'm2', role: 'player', text: 'yes, run it', ts: new Date(Date.now() + 1000).toISOString() })
  const ok = await approveRun.invoke({ run: card.id, player_words: 'yes, run it' })
  expect(ok.isError).toBeFalsy()
  expect(ctx.fal.run).toHaveBeenCalledTimes(1)
  // the tool works on Genio's own generation service, which read the quote from disk
  expect(agentGeneration(ctx).status(card.id, 'main').approval).toBe('approved by you in your own words')
  agentGeneration(ctx).stop()
})

it('keeps the hard cap over approvals, including concurrent approvals and cap changes before approval', async () => {
  write('.genio/fal/config.json', { budget: { monthly_usd: 0.15 } })
  const q = await service.fal('main', args())
  expect(q.status).toBe('awaiting_approval')
  write('.genio/fal/config.json', { budget: { monthly_usd: 0.05 } })
  await expect(service.approve(q.id, 'main', 'yes')).rejects.toThrow('hard stop')
  expect(ctx.fal.run).not.toHaveBeenCalled()
  write('.genio/fal/config.json', { budget: { monthly_usd: 0.15 } })
  const [a, b] = [await service.fal('main', args()), await service.fal('main', args())]
  const results = await Promise.allSettled([service.approve(a.id, 'main', 'yes'), service.approve(b.id, 'main', 'yes')])
  expect(results.map(r => (r.status === 'fulfilled' ? r.value.status : 'rejected')).sort()).toEqual(['failed', 'running'])
  expect(ctx.fal.run).toHaveBeenCalledTimes(1)
  expect(generationSpent(ctx, 'test')).toBeCloseTo(0.1)
})

it('places completed provider output through asset_locate into the nested engine, records provenance and never overwrites', async () => {
  const card = await service.fal('main', args())
  await service.approve(card.id, 'main', 'yes', 'genio', 'card')
  const source = path.join(dir, 'sound.wav'); fs.writeFileSync(source, 'RIFF-new')
  const r = runs[0]; r.status = 'completed'; r.requestId = 'request'; r.outputs = [{ fileName: 'sound.wav', field: 'audio', kind: 'audio', url: '', localPath: source }]
  recordGenerationSpend(ctx, 'fal', r)
  bus.publish({ type: 'fal-run', run: r })
  await vi.waitFor(() => expect(service.status(card.id, 'main').status).toBe('completed'))
  const saved = service.status(card.id, 'main').paths[0]
  expect(saved).toBe('Game/Assets/Audio/SFX/door-02.wav')
  expect(fs.readFileSync(path.join(project.path, saved), 'utf8')).toBe('RIFF-new')
  expect(JSON.parse(fs.readFileSync(path.join(project.path, '.genio/provenance', saved + '.json'), 'utf8'))).toMatchObject({ by: 'genio', provider: 'fal', sha256: sha256File(source) })
  expect(readSpend(project.path)).toHaveLength(1)
  expect(generationSpent(ctx, 'test')).toBeCloseTo(0.1)
  expect(ctx.stats.unlock).toHaveBeenCalledWith('agent-asset-first')
  expect(ctx.stats.unlock).toHaveBeenCalledWith('asset-placed-first')
  await expect(service.place('main', { world: 'test', run: card.id, output: 0, path: saved, player_words: 'place it' })).rejects.toThrow('already exists')
  await expect(service.place('main', { world: 'test', run: card.id, output: 0, path: saved, player_words: 'place it', overwrite_words: 'replace door-02.wav' })).resolves.toMatchObject({ ok: true })
  expect(readSpend(project.path)).toHaveLength(1)
})

const BIBLE = `# Art Bible: Test
## Style
Chunky low-poly shapes in soft daylight.
## References
![Icon sheet](../Game/Art/icons.png "style sprites 3")
## Sprites & icons
Thick readable silhouettes.
## Audio
Warm acoustic medieval.
## Animation
Weighty, slightly slow.
`

it("applies the project's Art Bible to every generation tool and records it in provenance", async () => {
  write('.genio/art-bible.md', BIBLE)
  write('Game/Art/icons.png', 'png')
  const ref = path.join(project.path, 'Game', 'Art', 'icons.png')
  // FAL: the catalogue marks fal-ai/test as audio, so only the Audio section applies
  const card = await service.fal('main', args())
  await service.approve(card.id, 'main', 'yes')
  expect(runs[0].input).toEqual({ prompt: 'door creak. Warm acoustic medieval.' })
  expect(runs[0].artBible).toMatchObject({ type: 'audio', applied: ['type'], refs: [] })
  expect(card.artBible).toMatchObject({ type: 'audio', applied: ['type'] })
  await service.fal('main', args({ art_bible: false })).then(q => service.approve(q.id, 'main', 'yes'))
  expect(runs[1].input).toEqual({ prompt: 'door creak' })
  expect(runs[1].artBible).toBeUndefined()

  // Codex: style after the prompt, the type's reference attached, art_bible in the placed image's provenance
  const sent = () => (globalThis as { sentImageArgs?: { prompt: string; refs: string[] } }).sentImageArgs!
  const a = { world: 'test', place: 'Game/Assets/UI/icon.png', player_words: 'make an icon', prompt: 'a shield icon', count: 1, refs: [], transparent: false, asset_type: 'sprites' }
  const image = await service.image('main', a)
  expect(sent().prompt).toMatch(/^a shield icon\nArt direction: Chunky low-poly shapes in soft daylight\./)
  expect(sent().prompt).toContain('Sprites & icons: Thick readable silhouettes.')
  expect(sent().refs).toEqual([ref])
  await vi.waitFor(() => expect(service.status(image.id, 'main').status).toBe('completed'))
  const prov = JSON.parse(fs.readFileSync(path.join(project.path, '.genio/provenance/Game/Assets/UI/icon.png.json'), 'utf8'))
  expect(prov.art_bible).toMatchObject({ type: 'sprites', refs: ['Game/Art/icons.png'], applied: expect.arrayContaining(['style', 'type', 'refs']) })
  expect(prov.art_bible.blob).toMatch(/^[0-9a-f]{40}$/)
  expect(prov.input.prompt).toBe(sent().prompt)
  await service.image('main', { ...a, place: 'Game/Assets/UI/plain.png', art_bible: false })
  expect(sent()).toMatchObject({ prompt: 'a shield icon', refs: [] })

  // Uthana: the Animation line only
  price = 0
  await service.motion('main', { world: 'test', model: 'text-to-motion-3.0', prompt: 'walk slowly', player_words: 'make a walk', length: 4 }).then(q => service.approve(q.id, 'main', 'yes'))
  expect(ctx.uthana.generate).toHaveBeenCalledWith(expect.objectContaining({ text: expect.objectContaining({ prompt: 'walk slowly. Weighty, slightly slow.' }), artBible: expect.objectContaining({ type: 'animation', applied: ['type'] }) }))
})

it('stops a generation on an Art Bible that cannot compile, and applies nothing for an empty one', async () => {
  write('.genio/art-bible.md', '---\nsource: docs/missing.md\n---\n# B\n')
  await expect(service.fal('main', args())).rejects.toThrow('art_bible: false')
  expect(ctx.fal.run).not.toHaveBeenCalled()
  await service.fal('main', args({ art_bible: false })).then(q => service.approve(q.id, 'main', 'yes'))
  write('.genio/art-bible.md', '  \n')
  await service.fal('main', args()).then(q => service.approve(q.id, 'main', 'yes'))
  expect(runs.map(r => r.input)).toEqual([{ prompt: 'door creak' }, { prompt: 'door creak' }])
  expect(runs.every(r => r.artBible === undefined)).toBe(true)
})

it('never exposes generation or approval tools to Bot and validates all tool schemas', () => {
  const names = ['fal_models', 'fal_generate', 'uthana_motion', 'uthana_character', 'generate_image', 'asset_place', 'approve_run', 'generation_status', 'art_bible']
  for (const role of ['bot', 'genio'] as const) {
    const defs = new Map<string, z.ZodRawShape>()
    const tool = ((name: string, _desc: string, shape: z.ZodRawShape) => { defs.set(name, shape); return {} }) as unknown as Parameters<typeof buildTools>[0]
    buildTools(tool, () => ctx, ctx.main.home, role)
    for (const name of names) expect(defs.has(name)).toBe(role === 'genio')
    if (role === 'genio') for (const shape of defs.values()) expect(() => z.toJSONSchema(z.object(shape))).not.toThrow()
  }
  expect(z.object(falGenerateShape).safeParse(args({ player_words: ' ' })).success).toBe(false)
  expect(z.object(uthanaMotionShape).safeParse({ world: 'test', prompt: 'walk', player_words: 'walk', length: 11 }).success).toBe(false)
})

it('rejects Bot at service boundaries, invalid schema inputs and unsafe destinations before any spend', async () => {
  await expect(service.fal('main', args(), 'bot')).rejects.toThrow('Bot')
  await expect(service.motion('main', { world: 'test', prompt: 'walk', player_words: 'walk', model: 'text-to-motion-3.0' }, 'bot')).rejects.toThrow('Bot')
  await expect(service.fal('main', args({ input: {} }))).rejects.toThrow('prompt')
  await expect(service.fal('main', args({ place: 'Game/Library/door.wav' }))).rejects.toThrow('Forbidden')
  expect(ctx.fal.run).not.toHaveBeenCalled()
})

it('rejects every forbidden directory, unsafe Windows paths, nonmedia and engine escapes', () => {
  for (const folder of ['.git', '.genio', 'Library', 'Temp', 'vendor', 'generated', 'ThirdParty', 'Plugins', 'Editor', 'Resources', 'StreamingAssets', 'Packages', 'BuildOutput', 'node_modules', 'AddressableAssetsData']) expect(() => placementTarget(project, `Game/${folder}/asset.png`), folder).toThrow()
  for (const file of ['../escape.png', 'C:/escape.png', 'Game/../asset.png', 'Game/Assets/a.png:stream', 'Game/Assets/con.png', 'Game/Assets/foo. /a.png', 'Assets/a.png', 'Game/Assets/a.cs', 'Game/Assets/a.prefab', 'Game/Assets/a.unity', 'Game/Assets/a.png.meta', 'Game/Assets/a.glb']) expect(() => placementTarget(project, file), file).toThrow()
})

it('refuses junctions in both media and provenance, and never accepts Bot at shared placement', async () => {
  const source = path.join(dir, 'source.png'); fs.writeFileSync(source, 'png')
  const a = { project, source, relative: 'Game/Assets/test.png', provenance: provenance(), spend: { t: new Date().toISOString(), provider: 'fal' } }
  await expect(placeOutput({ ...a, role: 'bot' })).rejects.toThrow('Bot')
  await expect(placeOutput({ ...a, role: 'genio' })).rejects.toThrow('player_words')
  fs.symlinkSync(dir, path.join(project.path, 'Game', 'linked'), 'junction')
  expect(() => placementTarget(project, 'Game/linked/test.png')).toThrow('link')
  fs.symlinkSync(dir, path.join(project.path, '.genio'), 'junction')
  await expect(placeOutput({ ...a, role: 'genio', playerWords: 'make it' })).rejects.toThrow('link')
  expect(fs.existsSync(path.join(project.path, a.relative))).toBe(false)
})

it('keeps spend after provider history is removed and counts external unit receipts once', () => {
  const r = { id: 'r', world: 'test', createdAt: new Date().toISOString(), estUsd: 0.2, requestId: 'req', status: 'failed' } as FalRun
  recordGenerationSpend(ctx, 'fal', r, true)
  recordGenerationSpend(ctx, 'fal', r)
  write('.genio/spend.jsonl', JSON.stringify({ t: r.createdAt, provider: 'fal', request_id: 'req', est_usd: 0.2 }) + '\n' + JSON.stringify({ t: r.createdAt, provider: 'fal', request_id: 'unit-1', est_usd: 0.1 }) + '\n')
  expect(generationSpent(ctx, 'test')).toBeCloseTo(0.3)
  write('.genio/fal/config.json', { budget: { monthly_usd: 0.3 } })
  expect(() => checkGenerationBudget(ctx, 'test', 0.01)).toThrow('hard stop')
})

it('never quotes Codex images even at zero paid budget and respects opt-out', async () => {
  write('.genio/fal/config.json', { budget: { monthly_usd: 0, confirm_over_usd: 0 } })
  const a = { world: 'test', place: 'Game/Assets/UI/icon.png', player_words: 'make an icon', prompt: 'an icon', count: 1, refs: [], transparent: false }
  const card = await service.image('main', a)
  expect(card.status).toBe('running')
  await vi.waitFor(() => expect(service.status(card.id, 'main').status).toBe('completed'))
  expect(service.status(card.id, 'main').paths).toEqual(['Game/Assets/UI/icon.png'])
  write('.genio/fal/config.json', { providers: { codex: { enabled: false } } })
  await expect(service.image('main', a)).rejects.toThrow('disabled')
})

it('resumes a pending quote after restart without submitting until approval', async () => {
  price = 0.4
  const card = await service.fal('main', args())
  service.stop(); service = new AgentGeneration(ctx)
  expect(ctx.fal.run).not.toHaveBeenCalled()
  expect(service.status(card.id, 'main').status).toBe('awaiting_approval')
  await service.approve(card.id, 'main', 'yes')
  expect(ctx.fal.run).toHaveBeenCalledTimes(1)
})

it('exports a quoted Uthana motion as FBX for nested Unity and reuses an existing uploaded character', async () => {
  const uthanaRuns: UthanaRun[] = []
  ctx.uthana.runs = () => uthanaRuns
  ctx.uthana.generate = vi.fn(req => {
    const run: UthanaRun = { id: 'uth-motion', kind: 'text', model: req.model, world: req.world, characterId: req.characterId, input: { ...req.text }, status: 'running', files: [], estUsd: 0.8, createdAt: new Date().toISOString() }
    recordGenerationSpend(ctx, 'uthana', run, true); uthanaRuns.push(run); return run
  })
  ctx.uthana.saveToWorld = vi.fn(async req => {
    const source = path.join(dir, 'motion.fbx'); fs.writeFileSync(source, 'Kaydara FBX')
    return placeOutput({ project, source, relative: `${req.folder}/${req.fileName}`, provenance: { ...provenance(req.by), provider: 'uthana' }, spend: { t: new Date().toISOString(), provider: 'uthana', request_id: 'uthana:motion', est_usd: 0.8 } })
  })
  const q = await service.motion('main', { world: 'test', model: 'text-to-motion-3.0', prompt: 'walk slowly', player_words: 'make a walk' })
  expect(q.status).toBe('awaiting_approval')
  await service.approve(q.id, 'main', 'yes')
  expect(ctx.uthana.generate).toHaveBeenCalledWith(expect.objectContaining({ characterId: 'c43tbGks3crJ' }))
  uthanaRuns[0].status = 'completed'; uthanaRuns[0].motionId = 'motion'
  bus.publish({ type: 'uthana-run', run: uthanaRuns[0] })
  await vi.waitFor(() => expect(service.status(q.id, 'main').status).toBe('completed'))
  expect(service.status(q.id, 'main').paths[0]).toBe('Game/Assets/Animations/new-motion.fbx')
  expect(service.status(q.id, 'main').warnings.join(' ')).toContain('Humanoid')
  write('Game/Assets/knight.fbx', 'character')
  const ch = { id: 'knight', source: 'Game/Assets/knight.fbx', sha256: sha256File(path.join(project.path, 'Game/Assets/knight.fbx')) }
  ctx.uthana.world = vi.fn(() => ({ characters: [ch] }) as never)
  expect(await service.character('main', { world: 'test', path: ch.source, player_words: 'use my knight', auto_rig: true })).toEqual({ character: ch, reused: true })
  expect(ctx.uthana.upload).not.toHaveBeenCalled()
})

it('refuses an upload whose bytes changed after the quote', async () => {
  write('.genio/fal/config.json', { budget: { confirm_over_usd: 0 } })
  write('Game/Assets/knight.fbx', 'old character')
  const q = await service.character('main', { world: 'test', path: 'Game/Assets/knight.fbx', player_words: 'rig this', auto_rig: true })
  if (!('id' in q)) throw new Error('Expected a quote')
  write('Game/Assets/knight.fbx', 'new character')
  const events: GenioEvent[] = []
  const off = bus.onEvent(e => { if (e.type === 'generation') events.push(e) })
  expect((await service.approve(q.id, 'main', 'yes')).status).toBe('failed')
  off()
  expect(ctx.uthana.upload).not.toHaveBeenCalled()
  // The failed card is shown in chat and settles the panel's generating count; Genio is not woken for it.
  expect((ctx.main.workspace.post as Mock).mock.lastCall?.[0]).toMatchObject({ id: q.id, generation: { status: 'failed' } })
  expect(events.at(-1)).toEqual({ type: 'generation', workspace: 'main', id: q.id, active: false })
  expect(ctx.main.wakes!.enqueue).not.toHaveBeenCalled()
})

it('refuses custom vendor directories even when they have no indexed media', async () => {
  write('.genio/assets.json', { vendor: ['Game/Assets/StorePack'] })
  await expect(service.fal('main', args({ place: 'Game/Assets/StorePack/Audio/door.wav' }))).rejects.toThrow('Vendor')
  expect(ctx.fal.run).not.toHaveBeenCalled()
})

it('rejects new folders anywhere beneath an inferred vendor pack root', () => {
  write('Game/Assets/StorePack/Documentation/readme.txt', 'docs')
  write('Game/Assets/StorePack/Demo/demo.unity', 'scene')
  write('Game/Assets/StorePack/Textures/vendor.png', 'vendor image')
  expect(() => placementTarget(project, 'Game/Assets/StorePack/NewFolder/door.wav')).toThrow('Vendor pack root')
})

it('fails closed on malformed world budgets', () => {
  write('.genio/fal/config.json', '{broken')
  expect(() => checkGenerationBudget(ctx, 'test', 0.1)).toThrow()
  write('.genio/fal/config.json', { budget: { monthly_usd: 'unlimited' } })
  expect(() => checkGenerationBudget(ctx, 'test', 0.1)).toThrow('Invalid generation budget')
})
