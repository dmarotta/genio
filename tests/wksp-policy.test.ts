import { describe, expect, it } from 'vitest'
import { decideTool } from '../src/main/wksp'

const ps = (command: string): { command: string } => ({ command })

describe('decideTool: chat shell approval mode', () => {
  it('ask mode: read-only shell runs, other shell asks', () => {
    expect(decideTool('genio', 'Bash', ps('git status'), 'ask')).toEqual({ behavior: 'allow' })
    expect(decideTool('genio', 'PowerShell', ps('Get-ChildItem src'), 'ask')).toMatchObject({ behavior: 'ask', input: 'Get-ChildItem src' })
    expect(decideTool('genio', 'Bash', ps('npm install'), 'ask')).toMatchObject({ behavior: 'ask' })
  })

  it('auto-shell mode: every Bash/PowerShell command runs without asking', () => {
    expect(decideTool('genio', 'PowerShell', ps('Get-ChildItem src | Select-Object Name'), 'auto-shell')).toEqual({ behavior: 'allow' })
    expect(decideTool('genio', 'Bash', ps('npm test > out.txt'), 'auto-shell')).toEqual({ behavior: 'allow' })
  })

  it('non-shell tools that prompt keep prompting in both modes', () => {
    for (const mode of ['ask', 'auto-shell'] as const) {
      expect(decideTool('genio', 'mcp__other__thing', { a: 1 }, mode)).toMatchObject({ behavior: 'ask' })
      expect(decideTool('genio', 'Read', { file_path: 'x' }, mode)).toEqual({ behavior: 'allow' })
    }
  })

  it('disallowed tools stay denied in both modes', () => {
    for (const mode of ['ask', 'auto-shell'] as const) {
      expect(decideTool('genio', 'Write', {}, mode).behavior).toBe('deny')
      expect(decideTool('genio', 'Edit', {}, mode).behavior).toBe('deny')
      expect(decideTool('genio', 'Agent', {}, mode).behavior).toBe('deny')
    }
  })

  it('the Bot ignores the mode and stays read-only', () => {
    for (const mode of ['ask', 'auto-shell'] as const) {
      expect(decideTool('bot', 'Bash', ps('git log'), mode)).toEqual({ behavior: 'allow' })
      expect(decideTool('bot', 'PowerShell', ps('Remove-Item x'), mode).behavior).toBe('deny')
      expect(decideTool('bot', 'mcp__other__thing', {}, mode).behavior).toBe('deny')
    }
  })
})
