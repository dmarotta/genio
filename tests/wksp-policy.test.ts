import { describe, expect, it } from 'vitest'
import { decideTool } from '../src/main/wksp'

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

  it('disallowed tools stay denied in every mode', () => {
    for (const mode of MODES) {
      expect(decideTool('genio', 'Write', {}, mode).behavior).toBe('deny')
      expect(decideTool('genio', 'Edit', {}, mode).behavior).toBe('deny')
      expect(decideTool('genio', 'Agent', {}, mode).behavior).toBe('deny')
      expect(decideTool('genio', 'Skill', { skill: 'configuration' }, mode)).toMatchObject({ behavior: 'deny', message: expect.stringContaining('settings_read') })
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
