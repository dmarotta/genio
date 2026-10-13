import { describe, expect, it } from 'vitest'
import { appendCommand, doorbellLine, kickoffPrompt, renderBrief, type BriefInput } from '../src/main/brief'
import { buildArgs, BUILTIN_HARNESSES, mergeHarnesses } from '../src/main/harness'

const base: BriefInput = {
  taskId: 'fix-jump-a1',
  kind: 'ship',
  project: 'platformer',
  worktree: 'C:\\genio\\worktrees\\platformer\\fix-jump-a1',
  branch: 'genio/fix-jump-a1',
  baseBranch: 'main',
  mode: 'no-mistakes',
  intent: 'Fix the double jump bug',
  statusFile: 'C:\\genio\\state\\fix-jump-a1.status',
  inboxDir: 'C:\\genio\\state\\fix-jump-a1.inbox',
  taskDataDir: 'C:\\genio\\data\\fix-jump-a1',
  engine: 'godot'
}

describe('renderBrief', () => {
  it('contains the core sections in order', () => {
    const b = renderBrief(base)
    const order = ['# Mission', "## Player's intent", '## Genio spec', '# Setup', '# Rules', '# Genio ping inbox', '# World memory', '# Engine notes', '# Definition of done']
    let last = -1
    for (const h of order) {
      const i = b.indexOf(h)
      expect(i, h).toBeGreaterThan(last)
      last = i
    }
  })

  it('uses forward-slash absolute paths and the isolation assertion', () => {
    const b = renderBrief(base)
    expect(b).toContain('C:/genio/state/fix-jump-a1.status')
    expect(b).toContain('git rev-parse --show-toplevel')
    expect(b).toContain('blocked: launched outside the isolated worktree')
    expect(b).not.toMatch(/C:\\genio/)
  })

  it('has a per-mode definition of done', () => {
    expect(renderBrief(base)).toContain('Delivery contract: mode=no-mistakes (Hardcore)')
    expect(renderBrief({ ...base, mode: 'direct-PR' })).toContain('done: PR <full https url>')
    expect(renderBrief({ ...base, mode: 'local-only' })).toContain('done: ready in branch genio/fix-jump-a1')
    const recon = renderBrief({ ...base, kind: 'scout', reportPath: 'C:\\genio\\data\\x\\report.md' })
    expect(recon).toContain('Delivery contract: kind=recon')
    expect(recon).toContain('C:/genio/data/x/report.md')
    expect(recon).toContain('800 words and 6000 characters')
    expect(renderBrief({ ...base, kind: 'scout', summaryWords: 400 })).toContain('400 words and 6000 characters')
  })

  it('never uses nautical vocabulary', () => {
    const b = renderBrief(base) + renderBrief({ ...base, kind: 'scout' })
    expect(b).not.toMatch(/captain|teammate|companion|ahoy|shipshape/i)
  })

  it('strips a Delivery contract line from brief includes', () => {
    const b = renderBrief({ ...base, briefInclude: 'Delivery contract: mode=evil\nUse tabs.' })
    expect(b).toContain('Use tabs.')
    expect(b.match(/Delivery contract:/g)?.length).toBe(1)
  })
})

describe('helpers', () => {
  it('appendCommand and doorbell use forward slashes', () => {
    expect(appendCommand('C:\\a\\b.status')).toBe('echo "working: <one short line>" >> "C:/a/b.status"')
    expect(doorbellLine('C:\\x\\t.inbox')).toContain('C:/x/t.inbox/handled/')
    expect(kickoffPrompt('C:\\d\\brief.md')).toContain('C:/d/brief.md')
  })
})

describe('buildArgs', () => {
  const claude = BUILTIN_HARNESSES.find((h) => h.id === 'claude')!
  const codex = BUILTIN_HARNESSES.find((h) => h.id === 'codex')!
  const opencode = BUILTIN_HARNESSES.find((h) => h.id === 'opencode')!

  it('places model/effort before the prompt and expands permissions', () => {
    const a = buildArgs(claude, { model: 'm1', effort: 'high', prompt: 'go', settings: 's.json' }, { claudePermissionMode: 'bypass' })
    expect(a).toEqual(['--dangerously-skip-permissions', '--settings', 's.json', '--model', 'm1', '--effort', 'high', 'go'])
  })

  it('drops empty tokens with their flag', () => {
    const a = buildArgs(claude, { prompt: 'go' }, { claudePermissionMode: 'auto' })
    expect(a).toEqual(['--permission-mode', 'auto', 'go'])
  })

  it('handles flag-paired prompts and subcommand resume', () => {
    expect(buildArgs(opencode, { prompt: 'go', model: 'x/y' }, { claudePermissionMode: 'bypass' })).toEqual(['--model', 'x/y', '--prompt', 'go'])
    expect(buildArgs(codex, { resume: true, sessionId: 'unit-session', effort: 'low' }, { claudePermissionMode: 'bypass' })).toEqual([
      'resume',
      'unit-session',
      '--dangerously-bypass-approvals-and-sandbox',
      '-c',
      'model_reasoning_effort="low"'
    ])
    expect(buildArgs(claude, { resume: true }, { claudePermissionMode: 'bypass' })).toEqual(['--dangerously-skip-permissions', '--continue'])
  })

  it('starts Codex fresh with the progress prompt when no session can be found', () => {
    expect(buildArgs(codex, { resume: true, prompt: 'Read the latest Progress note', cwd: '/unit' }, { claudePermissionMode: 'bypass' }))
      .toEqual(['--dangerously-bypass-approvals-and-sandbox', 'Read the latest Progress note'])
  })

  it('never uses a persisted Codex --last adapter when relaunching', () => {
    const saved = mergeHarnesses([{ ...codex, resumeArgs: ['resume', '--last'] }]).find(h => h.id === 'codex')!
    expect(buildArgs(saved, { resume: true, sessionId: 'own-session', prompt: 'continue' }, { claudePermissionMode: 'auto' }))
      .toEqual(['resume', 'own-session', '--dangerously-bypass-approvals-and-sandbox', 'continue'])
    expect(buildArgs(saved, { resume: true, prompt: 'continue' }, { claudePermissionMode: 'auto' }))
      .toEqual(['--dangerously-bypass-approvals-and-sandbox', 'continue'])
    expect(buildArgs(saved, { resume: false, sessionId: 'own-session', prompt: 'start' }, { claudePermissionMode: 'auto' }))
      .toEqual(['--dangerously-bypass-approvals-and-sandbox', 'start'])
  })
})
