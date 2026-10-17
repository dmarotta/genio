import { describe, expect, it } from 'vitest'
import { decideTool } from '../src/main/wksp'
import { interruptibleTool } from '../src/main/chat-tool-policy'

const ps = (command: string): { command: string } => ({ command })
const MODES = ['ask', 'auto-shell', 'all'] as const

describe('decideTool: chat shell approval mode', () => {
  it('ask mode: read-only shell runs, other shell asks', () => {
    expect(decideTool('genio', 'Bash', ps('git status'), 'ask')).toEqual({ behavior: 'allow' })
    expect(decideTool('genio', 'PowerShell', ps('Get-ChildItem src'), 'ask')).toMatchObject({ behavior: 'ask', input: 'Get-ChildItem src' })
    expect(decideTool('genio', 'Bash', ps('npm install'), 'ask')).toMatchObject({ behavior: 'ask' })
  })

  it('auto-shell and YOLO modes: every Bash/PowerShell command runs without asking', () => {
    for (const mode of ['auto-shell', 'all'] as const) {
      expect(decideTool('genio', 'PowerShell', ps('Get-ChildItem src | Select-Object Name'), mode)).toEqual({ behavior: 'allow' })
      expect(decideTool('genio', 'Bash', ps('npm test > out.txt'), mode)).toEqual({ behavior: 'allow' })
    }
  })

  it('non-shell tools that prompt keep prompting in ask and auto-shell', () => {
    for (const mode of ['ask', 'auto-shell'] as const) {
      expect(decideTool('genio', 'mcp__other__thing', { a: 1 }, mode)).toMatchObject({ behavior: 'ask' })
      expect(decideTool('genio', 'Read', { file_path: 'x' }, mode)).toEqual({ behavior: 'allow' })
    }
  })

  it('YOLO mode: non-shell tools that would prompt are allowed', () => {
    expect(decideTool('genio', 'mcp__other__thing', { a: 1 }, 'all')).toEqual({ behavior: 'allow' })
    expect(decideTool('genio', 'WebFetch', { url: 'https://example.com' }, 'all')).toEqual({ behavior: 'allow' })
  })

  it('edits, writes and subagents follow the approval mode for the chat and allies; Skill stays routed to skill_read', () => {
    for (const role of ['genio', 'ally'] as const) {
      for (const name of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task', 'Workflow', 'EnterWorktree']) {
        expect(decideTool(role, name, { file_path: 'src/a.ts' }, 'ask'), name).toMatchObject({ behavior: 'ask' })
        expect(decideTool(role, name, { file_path: 'src/a.ts' }, 'auto-shell'), name).toMatchObject({ behavior: 'ask' })
        expect(decideTool(role, name, { file_path: 'src/a.ts' }, 'all'), name).toEqual({ behavior: 'allow' })
      }
    }
    for (const mode of MODES) {
      expect(decideTool('genio', 'Skill', { skill: 'configuration' }, mode)).toMatchObject({ behavior: 'deny', message: expect.stringContaining('settings_read') })
      expect(decideTool('bot', 'Write', {}, mode).behavior).toBe('deny')
      expect(decideTool('design', 'Edit', {}, mode).behavior).toBe('deny')
    }
  })

  it('never reads, writes or prints credentials, logins or spend records, in any mode', () => {
    const home = 'C:\\Users\\p'
    for (const mode of MODES) {
      for (const [name, input] of [
        ['Read', { file_path: `${home}\\.codex\\auth.json` }], ['Read', { file_path: '/home/p/.claude/.credentials.json' }],
        ['Write', { file_path: 'game/.env', content: 'X=1' }], ['Edit', { file_path: `${home}\\.genio\\data\\spend-grants.jsonl` }],
        ['Grep', { pattern: 'key', path: '~/.ssh' }], ['Write', { file_path: 'game/.genio/fal/config.json' }],
        ['Bash', ps('cat ~/.codex/auth.json')], ['PowerShell', ps('Get-ChildItem env:')], ['Bash', ps('printenv')], ['Bash', ps('echo $FAL_KEY')],
        ['Bash', ps('codex login')], ['PowerShell', ps('claude setup-token')], ['Bash', ps('gh auth token')], ['Read', { file_path: 'x/secrets.json' }]
      ] as const) {
        for (const role of ['genio', 'ally', 'bot', 'design'] as const) {
          expect(decideTool(role, name, input, mode), `${role} ${name} ${JSON.stringify(input)}`).toMatchObject({ behavior: 'deny', message: expect.stringContaining('Credentials') })
        }
      }
      // ordinary project files are not caught
      expect(decideTool('genio', 'Read', { file_path: 'game/CLAUDE.md' }, mode)).toEqual({ behavior: 'allow' })
      expect(decideTool('genio', 'Read', { file_path: 'game/src/env.ts' }, mode)).toEqual({ behavior: 'allow' })
      expect(decideTool('genio', 'Bash', ps('git log --oneline'), mode)).toEqual({ behavior: 'allow' })
    }
  })

  it('the Bot ignores the mode and stays read-only', () => {
    for (const mode of MODES) {
      expect(decideTool('bot', 'Bash', ps('git log'), mode)).toEqual({ behavior: 'allow' })
      expect(decideTool('bot', 'PowerShell', ps('Remove-Item x'), mode).behavior).toBe('deny')
      expect(decideTool('bot', 'mcp__other__thing', {}, mode).behavior).toBe('deny')
    }
  })
})

describe('interruptibleTool: what a steering interrupt may cut short', () => {
  it('cuts reads and waits', () => {
    expect(interruptibleTool('Read', { file_path: 'x' })).toBe(true)
    expect(interruptibleTool('Grep', { pattern: 'x' })).toBe(true)
    expect(interruptibleTool('Bash', ps('git status'))).toBe(true)
    expect(interruptibleTool('PowerShell', ps("Start-Sleep 75; $d='C:\\data'; Get-ChildItem $d -Recurse -File | Select-Object -ExpandProperty FullName"))).toBe(true)
    expect(interruptibleTool('Bash', ps('sleep 30 && tail -n 20 log.txt'))).toBe(true)
  })

  it('lets anything that could be left half done finish', () => {
    expect(interruptibleTool('mcp__genio__deploy', {})).toBe(false)
    expect(interruptibleTool('PowerShell', ps('Start-Sleep 5; Remove-Item x'))).toBe(false)
    expect(interruptibleTool('PowerShell', ps('Get-ChildItem | Where-Object { Remove-Item $_ }'))).toBe(false)
    expect(interruptibleTool('Bash', ps('npm test > out.txt'))).toBe(false)
    expect(interruptibleTool('PowerShell', ps('$x = $(npm install)'))).toBe(false)
    expect(interruptibleTool('Bash', ps(''))).toBe(false)
  })

  it('never changes what runs without asking', () => {
    expect(decideTool('genio', 'PowerShell', ps('Start-Sleep 75'), 'ask')).toMatchObject({ behavior: 'ask' })
  })
})