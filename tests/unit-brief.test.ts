import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { briefIntent, briefSummary, clipSummary, deriveSummary, specParagraph, SUMMARY_CHARS } from '../src/shared/unit-brief'
import { renderBrief, type BriefInput } from '../src/main/brief'
import { BRIEF_BOILERPLATE } from './unit-brief-boilerplate'

/** Real unit briefs from the data folder (and a rendered Generator brief), trimmed: the mission in full, then each Genio section's first lines. */
const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, 'fixtures', 'briefs', `${name}.md`), 'utf8')
const BRIEFS = Object.fromEntries(['build', 'recon', 'modeller', 'generator', 'plan-step'].map((n) => [n, fixture(n)]))

describe('the fallback summary, derived from real briefs', () => {
  it('reads the player\'s own words as written and a short spec summary cut at a sentence end', () => {
    const intents: Record<string, string> = {
      build: 'in the timeline let\'s rename NOTE to EVENT maybe?',
      recon: 'is it possible to make play streaming fast, is really slow -- can unity and the game share some kind of buffer on the gpu or something -- like direct read and write of same mem; in parallel recon the shared buffer idea',
      modeller: 'make a new model unit I want to check the UI of the unit, then do not merge it',
      generator: 'a door creak and a coin pickup sound for the tavern',
      'plan-step': 'starting unity step is taking ages -- we really need to figure it out damn; I suppose we need to retain play copies then -- but yeah periodic delete, even daily, no need to wait for 7 days'
    }
    for (const [name, brief] of Object.entries(BRIEFS)) {
      const { ask, summary } = briefSummary(undefined, brief)
      expect(ask, name).toBe(intents[name])
      expect(summary.length, name).toBeLessThanOrEqual(SUMMARY_CHARS)
      expect(summary.length, name).toBeGreaterThan(100)
      expect(summary, name).toMatch(/[.!?]$/)
      const spec = brief.slice(brief.indexOf('## Genio spec'))
      expect(spec.replace(/\s+/g, ' '), name).toContain(summary.replace(/\s+/g, ' '))
      for (const b of BRIEF_BOILERPLATE) expect(summary, `${name}: ${b}`).not.toContain(b)
    }
    expect(briefSummary(undefined, BRIEFS.modeller).summary).toBe('This is a Modeller UI check for the player: build a small stylized low-poly wooden sailing ship (a little pirate galleon sized for a diorama) in the usual live steps so the player can watch the Modeller page.')
    // a Generator's spec: its first paragraph only
    expect(briefSummary(undefined, BRIEFS.generator).summary).toBe('Make two sound effects for the tavern: a slow door creak and a bright coin pickup. Place them under Game/Assets/Audio and keep each under a second.')
    expect(briefSummary(undefined, BRIEFS['plan-step']).summary).toMatch(/^Implement build 1 of the Play start speed Recon/)
  })

  it('falls back to the ask when Genio wrote no spec, and prefers the summary Genio wrote', () => {
    const input: BriefInput = {
      taskId: 'jump-a1', kind: 'ship', project: 'game', worktree: 'C:\\w\\jump-a1', branch: 'genio/jump-a1', baseBranch: 'main', mode: 'local-only',
      intent: 'fix the double jump', statusFile: 'C:\\s\\jump-a1.status', inboxDir: 'C:\\s\\jump-a1.inbox', taskDataDir: 'C:\\d\\jump-a1', engine: 'unity',
      planContext: 'Plan: Movement (plan-a1) · step 1/2 "Fix jump"\nLanded before you (already on the base branch: build on it):'
    }
    const bare = renderBrief(input)
    expect(bare).toContain('No extra build instructions')
    expect(briefSummary(undefined, bare)).toEqual({ ask: 'fix the double jump', summary: 'fix the double jump' })
    expect(briefSummary('  Fixes the double jump.  ', bare)).toEqual({ ask: 'fix the double jump', summary: 'Fixes the double jump.' })
    expect(briefSummary(undefined, renderBrief({ ...input, spec: 'Make the second jump work again.' })).summary).toBe('Make the second jump work again.')
    expect(briefSummary(undefined, '')).toEqual({ ask: '', summary: '' })
    expect(briefIntent(renderBrief({ ...input, intent: '' }))).toBe('')
  })

  it('cuts at a real sentence end, never inside a file name or an abbreviation', () => {
    const s = `Edit src/main/prompts.ts and the tests, e.g. the cap test. ${'More words here. '.repeat(60)}`
    const cut = clipSummary(s, 120)
    expect(cut.startsWith('Edit src/main/prompts.ts and the tests, e.g. the cap test.')).toBe(true)
    expect(cut).toMatch(/\.$/)
    expect(cut.length).toBeLessThanOrEqual(120)
    expect(clipSummary('word '.repeat(200), 100)).toMatch(/^word( word)+…$/)
    expect(clipSummary('Short and done.')).toBe('Short and done.')
    expect(specParagraph('## Context\n\nThe real first paragraph.\n\nSecond.')).toBe('The real first paragraph.')
    expect(deriveSummary('my ask', 'No extra build instructions. Deliver exactly the intent above; anything beyond it is out of scope.')).toBe('my ask')
  })
})
