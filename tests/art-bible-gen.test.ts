import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { artBibleBriefLines, readBibleFile, unitArtBible, unitArtBibleEnv, writeBibleFile } from '../src/main/art-bible-gen'
import { renderBrief, type BriefInput } from '../src/main/brief'
import { customContract } from '../src/main/prompts'
import { gitBlobSha } from '../resources/unit-skills/genio/lib/art-bible.mjs'

let tmp: string, main: string, wt: string, taskDir: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-art-bible-gen-'))
  main = path.join(tmp, 'main'); wt = path.join(tmp, 'wt'); taskDir = path.join(tmp, 'data', 'task')
  for (const d of [main, wt]) fs.mkdirSync(path.join(d, '.genio'), { recursive: true })
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const BIBLE = '# Art Bible\n## Style\nChunky low-poly shapes.\n'
const put = (root: string, text: string): void => fs.writeFileSync(path.join(root, '.genio', 'art-bible.md'), text)
const fwd = (p: string): string => p.replace(/\\/g, '/')
const CLI = 'C:/genio/skills/genio/lib/genio-art.mjs'

describe('the Art Bible a unit sees', () => {
  it('is nothing without a bible: no env, no brief lines', () => {
    expect(unitArtBible(main, wt, taskDir)).toBeNull()
    put(main, '  \n'); put(wt, '')
    expect(unitArtBible(main, wt, taskDir)).toBeNull()
    expect(unitArtBibleEnv(main, wt, taskDir)).toEqual({})
    expect(artBibleBriefLines(null, CLI)).toEqual([])
  })

  it("points at the worktree's own bible when it matches the main copy", () => {
    put(main, BIBLE); put(wt, BIBLE)
    const b = unitArtBible(main, wt, taskDir)
    expect(b).toEqual({ file: fwd(path.join(wt, '.genio', 'art-bible.md')), blob: gitBlobSha(BIBLE), snapshot: false, empty: false })
    expect(fs.existsSync(path.join(taskDir, 'art-bible'))).toBe(false)
    expect(unitArtBibleEnv(main, wt, taskDir)).toEqual({ GENIO_ART_BIBLE: b!.file })
  })

  it("snapshots the player's uncommitted edits at launch, and an empty snapshot when they removed it", () => {
    put(main, BIBLE.replace('Chunky', 'Painted')); put(wt, BIBLE)
    const snap = path.join(taskDir, 'art-bible', 'art-bible.md')
    expect(unitArtBible(main, wt, taskDir)).toMatchObject({ file: fwd(snap), snapshot: true, empty: false })
    expect(fs.readFileSync(snap, 'utf8')).toContain('Painted')
    // new and uncommitted: the branch has none yet
    fs.rmSync(path.join(wt, '.genio', 'art-bible.md'))
    expect(unitArtBible(main, wt, taskDir)).toMatchObject({ snapshot: true, empty: false })
    // removed in the main copy but still on the branch: the helpers must apply nothing
    put(wt, BIBLE); fs.rmSync(path.join(main, '.genio', 'art-bible.md'))
    const gone = unitArtBible(main, wt, taskDir)!
    expect(gone).toMatchObject({ file: fwd(snap), snapshot: true, empty: true, blob: null })
    expect(fs.readFileSync(snap, 'utf8')).toBe('')
    expect(unitArtBibleEnv(main, wt, taskDir)).toEqual({ GENIO_ART_BIBLE: fwd(snap) })
    expect(artBibleBriefLines(gone, CLI)).toEqual([])
  })

  it('renders two brief lines under Tools only when the project has a bible', () => {
    put(main, BIBLE); put(wt, BIBLE)
    const lines = artBibleBriefLines(unitArtBible(main, wt, taskDir), CLI)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain(`version ${gitBlobSha(BIBLE).slice(0, 8)}`)
    expect(lines[0]).toContain('GENIO_ART_BIBLE')
    expect(lines[0]).toContain('--type <asset type>')
    expect(lines[1]).toContain(`node "${CLI}" compile --world . --type <t>`)
    expect(lines[1]).toContain('Never edit .genio/art-bible.md unless the mission says so.')
    const input: BriefInput = {
      taskId: 't-1', kind: 'ship', project: 'p', worktree: wt, branch: 'b', baseBranch: 'main', intent: 'x',
      statusFile: path.join(tmp, 's'), inboxDir: path.join(tmp, 'i'), taskDataDir: taskDir, tools: '- Assets: read the skill.'
    }
    const brief = renderBrief({ ...input, artBible: lines })
    const tools = brief.slice(brief.indexOf('# Tools'), brief.indexOf('# Definition of done'))
    expect(tools).toContain('- Assets: read the skill.\n- Art Bible: this project has one')
    expect(renderBrief(input)).not.toContain('Art Bible')
    expect(renderBrief({ ...input, tools: undefined, artBible: lines })).toContain('# Tools\n\n- Art Bible')
  })
})

describe('the art_bible chat tool helpers', () => {
  it('reads plainly, writes only what compiles, and never commits', () => {
    expect(readBibleFile(main)).toMatchObject({ path: '.genio/art-bible.md', exists: false, bible: null })
    const w = writeBibleFile(main, BIBLE)
    expect(w).toMatchObject({ written: true, summary: { style: 'Chunky low-poly shapes.' } })
    expect(fs.readFileSync(path.join(main, '.genio', 'art-bible.md'), 'utf8')).toBe(BIBLE)
    expect(readBibleFile(main)).toMatchObject({ exists: true, text: BIBLE, summary: { style: 'Chunky low-poly shapes.' } })
    expect(() => writeBibleFile(main, '---\nsource: docs/none.md\n---\n')).toThrow(/Not written/)
    expect(fs.readFileSync(path.join(main, '.genio', 'art-bible.md'), 'utf8')).toBe(BIBLE)
    expect(fs.existsSync(path.join(main, '.git'))).toBe(false)
  })
})

it('gives the chat one Art Bible line within the contract budget', () => {
  const contract = customContract({ gamertag: 'Alex', base: 'main', isAlly: false })
  const line = contract.split('\n').find((l) => l.startsWith('- Art Bible:'))
  expect(line).toBeDefined()
  expect(line!.length).toBeLessThan(200)
  expect(line).toContain('only when the player asks')
})
