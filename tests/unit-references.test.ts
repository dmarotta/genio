import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/main/secrets', () => ({ getSecret: () => undefined }))
import { Home } from '../src/main/home'
import { createBacklogService } from '../src/main/backlog'
import { createDecisionService } from '../src/main/decisions'
import { createWakeService } from '../src/main/wakes'
import { createPlanService } from '../src/main/plans'
import { createToolRegistry, type ToolRole } from '../src/main/wksp-tools'
import { renderBrief } from '../src/main/brief'
import {
  copyReferences, questReferencesDir, readReferences, referencesBriefLines, referenceViews, resolveAttachments, secretPathReason, stageReferences, unitReferencesDir,
  type AttachmentContext
} from '../src/main/unit-references'
import { REFERENCE_FILE_MAX_BYTES, REFERENCE_FOLDER_MAX_FILES, REFERENCES_MAX_BYTES, orthoView, referenceType } from '../src/shared/unit-references'
import type { AppCtx, CrewService, HomeCtx } from '../src/main/services'
import type { SpawnRequest } from '../src/shared/api'
import type { Task } from '../src/shared/types'

let tmp: string, genio: string, homeDir: string, project: string, outside: string, chatDir: string, actx: AttachmentContext
const write = (p: string, text = 'x'): string => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
  return p
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-refs-'))
  genio = path.join(tmp, '.genio')
  homeDir = tmp
  project = path.join(tmp, 'games', 'world')
  outside = path.join(tmp, 'Desktop')
  chatDir = path.join(genio, 'data', 'chat-images')
  write(path.join(chatDir, 'mg1-ab12.png'), 'png bytes')
  write(path.join(project, 'Assets', 'Art', 'hero.png'), 'hero')
  write(path.join(outside, 'concept.pdf'), '%PDF')
  actx = { chatDir, projectPath: project, genioRoot: genio, homeDir }
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('checking attachments', () => {
  it('takes chat images by id, files by absolute or project path, folders as their files and inline text, each with its note', () => {
    write(path.join(outside, 'refs', 'front.jpg'), 'front')
    write(path.join(outside, 'refs', 'sub', 'notes.md'), '# notes')
    write(path.join(outside, 'refs', '.git', 'config'), '[core]')
    write(path.join(outside, 'refs', 'node_modules', 'x', 'index.js'), '')
    const r = resolveAttachments([
      { source: 'mg1-ab12.png', note: 'the pasted sketch: match its silhouette' },
      { source: path.join(outside, 'concept.pdf') },
      { source: 'Assets/Art/hero.png', note: '  the current\n hero  ' },
      { source: path.join(outside, 'refs') },
      { name: 'page.md', text: 'https://example.com/dash\n\nThe dash lasts 0.2 s.', note: 'the page the player linked' },
      { name: 'stats', text: '{"hp": 3}' }
    ], actx)
    expect(r.rejected).toEqual([])
    expect(r.items.map((i) => [i.kind, i.name, i.source, i.note])).toEqual([
      ['file', 'mg1-ab12.png', 'chat image mg1-ab12.png', 'the pasted sketch: match its silhouette'],
      ['file', 'concept.pdf', path.join(outside, 'concept.pdf'), undefined],
      ['file', 'hero.png', path.join(project, 'Assets', 'Art', 'hero.png'), 'the current hero'],
      ['file', 'refs/front.jpg', path.join(outside, 'refs', 'front.jpg'), undefined],
      ['file', 'refs/sub/notes.md', path.join(outside, 'refs', 'sub', 'notes.md'), undefined],
      ['text', 'page.md', 'inline text', 'the page the player linked'],
      ['text', 'stats.txt', 'inline text', undefined]
    ])
  })

  it('refuses credential and config locations, secrets by name and Genio\'s private data, and says why', () => {
    const bad = [
      write(path.join(homeDir, '.ssh', 'id_ed25519')),
      write(path.join(homeDir, '.codex', 'auth.json')),
      write(path.join(homeDir, '.claude', 'settings.json')),
      write(path.join(homeDir, '.aws', 'config')),
      write(path.join(homeDir, '.gitconfig')),
      write(path.join(project, '.env')),
      write(path.join(project, '.env.local')),
      write(path.join(project, 'certs', 'server.pem')),
      write(path.join(project, 'credentials.json')),
      write(path.join(project, '.git', 'config')),
      write(path.join(genio, 'data', 'secrets.json')),
      write(path.join(genio, 'claude-home', 'notes.md')),
      write(path.join(genio, 'config', 'settings.json')),
      write(path.join(genio, 'data', 'chat.jsonl'))
    ]
    for (const p of bad) expect(secretPathReason(p, actx), p).toBeTruthy()
    const r = resolveAttachments([...bad.map((source) => ({ source })), { source: path.join(homeDir, '.codex') }], actx)
    expect(r.items).toEqual([])
    expect(r.rejected).toHaveLength(bad.length + 1)
    expect(r.rejected[1]).toMatch(/auth\.json: refused, its name says it holds secrets/)
    expect(r.rejected[2]).toMatch(/refused, it is in ~\/\.claude, a credential or config folder/)
    expect(r.rejected.at(-1)).toMatch(/\.codex: refused, it is in ~\/\.codex/)
    // shareable parts of Genio's folder and harmless look-alikes stay welcome
    for (const ok of [write(path.join(project, '.env.example')), write(path.join(genio, 'data', 'unit-1', 'report.md')), write(path.join(genio, 'worktrees', 'world', 'u1', 'a.ts')), path.join(chatDir, 'mg1-ab12.png')]) {
      expect(secretPathReason(ok, actx), ok).toBeUndefined()
    }
    // a folder skips the secret files inside it, naming each
    write(path.join(outside, 'kit', 'a.txt'))
    write(path.join(outside, 'kit', '.env'))
    const kit = resolveAttachments([{ source: path.join(outside, 'kit') }], actx)
    expect(kit.items.map((i) => i.name)).toEqual(['kit/a.txt'])
    expect(kit.rejected).toEqual([expect.stringMatching(/^kit\/\.env: refused, its name says it holds secrets/)])
  })

  it('refuses what is missing, outside the project, a bare URL, an unknown chat image, and oversize files, and caps folders', () => {
    const big = path.join(outside, 'huge.mov')
    fs.writeFileSync(big, '')
    fs.truncateSync(big, REFERENCE_FILE_MAX_BYTES + 1)
    const r = resolveAttachments([
      { source: path.join(outside, 'gone.png') }, { source: '../escape.txt' }, { source: 'https://example.com' }, { source: 'zz9-zz99.png' },
      { source: big }, { name: 'x.md', text: '   ' }, { text: 'no name' }, { source: path.join(outside, 'concept.pdf'), text: 'both' }, {}
    ], actx)
    expect(r.items).toEqual([])
    expect(r.rejected).toEqual([
      `${path.join(outside, 'gone.png')}: not found`,
      '../escape.txt: a project-relative path must stay inside the project',
      "https://example.com: a URL is not a file; pass the page's text (and the URL) as inline text instead",
      'zz9-zz99.png: no chat image with this id in this chat',
      `${big}: too large (25 MB; the limit is 25 MB per file)`,
      'x.md: the text is empty',
      'inline text: needs a name (for example notes.md)',
      'inline text: give either source or text, not both',
      'an attachment with neither source nor text'
    ])
    // the unit's total counts what it already has
    expect(resolveAttachments([{ source: path.join(outside, 'concept.pdf') }], { ...actx, existingBytes: REFERENCES_MAX_BYTES - 2 }).rejected).toEqual([
      `${path.join(outside, 'concept.pdf')}: would pass the 100 MB limit for one unit`
    ])
    for (let i = 0; i <= REFERENCE_FOLDER_MAX_FILES; i++) write(path.join(outside, 'many', `f${String(i).padStart(3, '0')}.txt`))
    const many = resolveAttachments([{ source: path.join(outside, 'many') }], actx)
    expect(many.items).toHaveLength(REFERENCE_FOLDER_MAX_FILES)
    expect(many.rejected).toEqual([`${path.join(outside, 'many')}: only its first ${REFERENCE_FOLDER_MAX_FILES} files were added (the folder cap)`])
  })
})

describe('copies and references.json', () => {
  it('copies into the folder with source, note, size and type, lists a repeat once and renames a different file with a taken name', () => {
    const dir = path.join(tmp, 'q', 'references')
    write(path.join(tmp, 'other', 'concept.pdf'), 'another pdf')
    const first = resolveAttachments([{ source: path.join(outside, 'concept.pdf'), note: 'the layout' }, { name: 'brief.md', text: 'hi' }], actx).items
    stageReferences(dir, first, 'T')
    stageReferences(dir, [...first, ...resolveAttachments([{ source: path.join(tmp, 'other', 'concept.pdf') }], actx).items], 'T')
    expect(readReferences(dir)).toEqual([
      { file: 'concept.pdf', source: path.join(outside, 'concept.pdf'), note: 'the layout', bytes: 4, type: 'pdf', addedAt: 'T' },
      { file: 'brief.md', source: 'inline text', bytes: 2, type: 'text', addedAt: 'T' },
      { file: 'concept-2.pdf', source: path.join(tmp, 'other', 'concept.pdf'), bytes: 11, type: 'pdf', addedAt: 'T' }
    ])
    expect(fs.readFileSync(path.join(dir, 'brief.md'), 'utf8')).toBe('hi')
    expect(fs.readFileSync(path.join(dir, 'concept-2.pdf'), 'utf8')).toBe('another pdf')
  })

  it('classifies any type, and the Brief tab rows carry thumbnails for small images only', () => {
    expect(['a.png', 'b.PSD', 'c.pdf', 'd.docx', 'e.xlsx', 'f.pptx', 'g.wav', 'h.mp4', 'i.fbx', 'j.zip', 'k.json', 'l.cs', 'm.bin', 'noext'].map(referenceType))
      .toEqual(['image', 'image', 'pdf', 'document', 'spreadsheet', 'slides', 'audio', 'video', 'model', 'archive', 'text', 'text', 'other', 'other'])
    const dir = path.join(tmp, 'u', 'references')
    stageReferences(dir, resolveAttachments([{ source: 'mg1-ab12.png', note: 'sketch' }, { source: path.join(outside, 'concept.pdf') }], actx).items)
    const views = referenceViews(dir)
    expect(views.map((v) => [v.file, v.note, v.type, v.path])).toEqual([['mg1-ab12.png', 'sketch', 'image', path.join(dir, 'mg1-ab12.png')], ['concept.pdf', undefined, 'pdf', path.join(dir, 'concept.pdf')]])
    expect(views[0].thumb).toBe(`data:image/png;base64,${Buffer.from('png bytes').toString('base64')}`)
    expect(views[1].thumb).toBeUndefined()
    expect(referenceViews(path.join(tmp, 'none'))).toEqual([])
  })

  it('tags an image of one orthographic view from its name or note, never perspective art or a name with two views', () => {
    const cases: [string, string | undefined, string | undefined][] = [
      ['ship_side.png', undefined, 'side'], ['refs/front.jpg', undefined, 'front'], ['tank-top.png', undefined, 'top'], ['floor_plan.png', undefined, 'top'],
      ['mg1-ab12.png', 'Side view of the ship', 'side'], ['mg1-ab12.png', 'the top-down view', 'top'], ['mg1-ab12.png', 'front elevation, 30 m long', 'front'],
      ['front_3-4.png', undefined, undefined], ['ship_side.png', 'concept art', undefined], ['front_side.png', undefined, undefined],
      ['mg1-ab12.png', 'the front has red stripes', undefined], ['frontier.png', undefined, undefined], ['mg1-ab12.png', 'perspective, side view', undefined]
    ]
    for (const [file, note, view] of cases) expect([file, note, orthoView(file, note)]).toEqual([file, note, view])
    const dir = path.join(tmp, 'tags', 'references')
    write(path.join(outside, 'ship_side.png'), 'png')
    write(path.join(outside, 'side_notes.md'), 'text')
    stageReferences(dir, resolveAttachments([{ source: path.join(outside, 'ship_side.png') }, { source: path.join(outside, 'side_notes.md') }], actx).items, 'T')
    // only images are tagged
    expect(readReferences(dir).map((r) => [r.file, r.view])).toEqual([['ship_side.png', 'side'], ['side_notes.md', undefined]])
  })
})

describe('the brief\'s References section', () => {
  const base = { taskId: 'u1', kind: 'ship' as const, project: 'world', worktree: '/w', branch: 'b', baseBranch: 'main', intent: 'model the tower', statusFile: '/s', inboxDir: '/i', taskDataDir: '/d/u1' }

  it('lists each file with its note and says how to open the types present, never the contents', () => {
    const dir = path.join(tmp, 'u1', 'references')
    stageReferences(dir, resolveAttachments([
      { source: 'mg1-ab12.png', note: 'front view' }, { name: 'lore.md', text: 'SECRET LORE TEXT' }, { source: path.join(outside, 'concept.pdf') }
    ], actx).items)
    write(path.join(outside, 'kit.zip'), 'PK')
    stageReferences(dir, resolveAttachments([{ source: path.join(outside, 'kit.zip') }], actx).items)
    const lines = referencesBriefLines(dir, readReferences(dir), { taskDir: path.join(tmp, 'u1'), blender: '/skills/blender', modeller: true })
    const brief = renderBrief({ ...base, references: lines })
    const section = brief.slice(brief.indexOf('## References'), brief.indexOf('# Setup'))
    expect(section).toContain('(also GENIO_REFERENCES), outside the worktree: never commit them')
    expect(section).toContain('- `mg1-ab12.png` (image): front view')
    expect(section).toContain('- `lore.md` (text)')
    expect(section).toContain('- `kit.zip` (archive)')
    expect(section).toMatch(/Images: open PNG, JPEG, GIF and WebP with your file-read tool/)
    expect(section).toMatch(/PDFs: read them with your file-read tool/)
    expect(section).toContain(`Archives (ZIP, 7z, TAR, .unitypackage): extract into \`${path.join(tmp, 'u1', 'references-extracted').replace(/\\/g, '/')}/<name>/\`, never into the worktree`)
    expect(section).not.toMatch(/Audio|Video|3D models|Spreadsheets/)
    expect(section).toMatch(/Modeller: Images of one orthographic view tagged in `.*references\.json` \(`"view": "front"`, `"side"` or `"top"`; .*\) are matched by numbers on every step: the review's `Reference <view>` lines\. Every step's review names the other references\. Compare each step's sheet with them \(open the reference images beside the sheet\)/)
    // the image's note says front view: Genio tagged it
    expect(readReferences(dir).find((r) => r.file === 'mg1-ab12.png')?.view).toBe('front')
    expect(section).not.toContain('SECRET LORE TEXT')
    expect(section).not.toContain('Generator:')
    // a Generator passes reference images to codex-image
    expect(referencesBriefLines(dir, readReferences(dir), { taskDir: path.join(tmp, 'u1'), generator: true }).join('\n')).toContain('to codex-image as `--ref <file>`')
    // nothing at all without references
    expect(renderBrief(base)).not.toContain('## References')
    expect(referencesBriefLines(dir, [], { taskDir: '/d' })).toEqual([])
  })
})

describe('the tools', () => {
  let root: string, home: Home, hc: HomeCtx, ctx: AppCtx, spawned: SpawnRequest[], tasks: Task[]
  beforeEach(() => {
    root = path.join(tmp, 'genio-home')
    home = new Home(root)
    home.ensure()
    write(path.join(home.data, 'chat-images', 'mg1-ab12.png'), 'png bytes')
    spawned = []
    tasks = []
    hc = { home, wksp: { deliverWakes: vi.fn(), say: vi.fn(), history: () => [] } } as unknown as HomeCtx
    hc.crew = {
      list: () => tasks, get: (id: string) => tasks.find((t) => t.id === id), update: () => undefined, capacityUsed: () => 0,
      statusEvents: () => [],
      spawn: vi.fn(async (req: SpawnRequest) => {
        spawned.push(req)
        const t = { id: `unit-${spawned.length}`, kind: req.kind, title: req.title, project: req.project, state: 'working', backlogId: req.backlogId, branch: 'b', mode: 'local-only' } as Task
        tasks.push(t)
        hc.backlog.markInFlight(req.backlogId!, t.id)
        return t
      })
    } as unknown as CrewService
    hc.backlog = createBacklogService(() => ctx, home)
    hc.decisions = createDecisionService(() => ctx, home)
    hc.wakes = createWakeService(() => ctx, home)
    hc.plans = createPlanService(() => ctx, home)
    ctx = {
      homes: new Map([['main', hc]]), main: hc, home: () => hc,
      projects: { get: (name: string) => (name === 'world' ? { name: 'world', path: project } : undefined) },
      dispatch: { capacity: () => ({ cap: 16, used: 0 }), quotaWait: () => undefined },
      ledger: { record: () => undefined }, settings: { get: () => ({}) }, allies: { list: () => [] }
    } as unknown as AppCtx
  })
  const tools = (role: ToolRole = 'genio') => {
    const list = createToolRegistry(() => ctx, home, role)
    return async (name: string, args: unknown): Promise<string> => {
      const r = await list.find((t) => t.name === name)!.invoke(args)
      if (r.isError) throw new Error((r.content[0] as { text: string }).text)
      return (r.content[0] as { text: string }).text
    }
  }
  const step = (key: string, after: string[] = []) => ({ key, title: `Step ${key}`, spec: `Implement ${key} completely, with its tests.`, after, acceptance: `${key} works` })

  it('deploy passes checked attachments to the unit and tells Genio what was refused and why', async () => {
    const call = tools()
    const key = write(path.join(homeDir, '.ssh', 'id_rsa'))
    const out = await call('deploy', { kind: 'ship', world: 'world', title: 'Model the tower', intent: 'model the tower like my sketch', modeller: true,
      attachments: [{ source: 'mg1-ab12.png', note: 'the sketch' }, { source: key }] })
    expect(out).toMatch(/^deployed unit-1/)
    expect(out).toContain(`attached 1 reference file\nnot attached (tell the player): ${key}: refused, its name says it holds secrets or keys`)
    expect(spawned[0].attachments).toEqual([{ kind: 'file', path: path.join(home.data, 'chat-images', 'mg1-ab12.png'), name: 'mg1-ab12.png', bytes: 9, source: 'chat image mg1-ab12.png', note: 'the sketch' }])
  })

  it('quest_add files them with the quest, quest_remove deletes them, and the Bot attaches nothing', async () => {
    const call = tools()
    const out = await call('quest_add', { title: 'Tavern sounds', world: 'world', notes: 'later', attachments: [{ name: 'mood.md', text: 'warm, wooden, busy' }] })
    const id = /quest (\S+) filed/.exec(out)![1]
    expect(out).toContain('attached 1 reference file')
    expect(readReferences(questReferencesDir(home.data, id)).map((r) => r.file)).toEqual(['mood.md'])
    await call('quest_remove', { id })
    expect(fs.existsSync(questReferencesDir(home.data, id))).toBe(false)
    const bot = await tools('bot')('quest_add', { title: 'Bot quest', world: 'world', attachments: [{ source: 'mg1-ab12.png' }] })
    expect(bot).toContain("not attached (tell the player): attachments come only from the player's chat")
  })

  it('a plan step keeps its attachments from filing until its release, even when the original is gone', async () => {
    const call = tools()
    const src = write(path.join(outside, 'layout.png'), 'layout')
    const created = JSON.parse(await call('plan_create', { world: 'world', title: 'Dash', intent: 'add the dash in two builds', start: false,
      steps: [step('core'), { ...step('ui', ['core']), attachments: [{ source: src, note: 'the HUD layout' }, { source: path.join(outside, 'nope.png') }] }] }))
    expect(created.attachments).toBe(`attached 1 reference file\nnot attached (tell the player): step ui: ${path.join(outside, 'nope.png')}: not found`)
    fs.rmSync(src)
    const ui = hc.plans.get(created.plan_id)!.steps[1]
    const questDir = questReferencesDir(home.data, ui.questId)
    expect(readReferences(questDir)).toMatchObject([{ file: 'layout.png', note: 'the HUD layout', type: 'image' }])
    // edit_step adds to them; add_step files its own
    expect(await call('plan_update', { plan_id: created.plan_id, op: 'edit_step', step: 'ui', patch: { attachments: [{ name: 'copy.md', text: 'DASH ready' }] } })).toMatch(/updated\nattached 1 reference file/)
    await call('plan_update', { plan_id: created.plan_id, op: 'add_step', new_step: { ...step('docs', ['ui']), attachments: [{ source: 'mg1-ab12.png' }] } })
    expect(readReferences(questReferencesDir(home.data, hc.plans.get(created.plan_id)!.steps[2].questId)).map((r) => r.file)).toEqual(['mg1-ab12.png'])
    // the unit's start copies them into its own data folder (crew.spawn does this for every quest)
    const unitDir = unitReferencesDir(home.taskDir('ui-unit'))
    expect(copyReferences(questDir, unitDir).map((r) => r.file)).toEqual(['layout.png', 'copy.md'])
    expect(fs.readFileSync(path.join(unitDir, 'layout.png'), 'utf8')).toBe('layout')
  })
})
