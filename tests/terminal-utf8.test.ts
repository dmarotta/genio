import { describe, expect, it } from 'vitest'
import { terminalEnv, utf8ConsoleSpawn, utf8ShellArgs } from '../src/main/terminals'
import { appendCommandPowerShell, renderBrief, type BriefInput } from '../src/main/brief'

describe('unit consoles speak UTF-8', () => {
  it('switches a Windows unit console to code page 65001 before the agent starts', () => {
    const exe = utf8ConsoleSpawn({ file: 'C:\\Tools\\claude.exe', args: ['--model', 'x', 'Read your brief at C:/a b/brief.md'] }, 'win32')
    expect(exe.args).toBe('/d /s /c "chcp 65001 >nul & C:\\Tools\\claude.exe --model x "Read your brief at C:/a b/brief.md""')
    const shim = utf8ConsoleSpawn({ file: 'cmd.exe', args: '/d /s /c ""C:\\npm\\codex.cmd" resume"' }, 'win32')
    expect(shim).toEqual({ file: 'cmd.exe', args: '/d /s /c "chcp 65001 >nul & "C:\\npm\\codex.cmd" resume"' })
  })

  it('leaves command lines cmd would rewrite, and other platforms, as they were', () => {
    for (const args of [['100%'], ['say "hi"'], ['two\nlines']]) {
      const sp = { file: 'claude.exe', args }
      expect(utf8ConsoleSpawn(sp, 'win32')).toBe(sp)
    }
    const sp = { file: '/usr/bin/claude', args: ['x'] }
    expect(utf8ConsoleSpawn(sp, 'linux')).toBe(sp)
  })

  it('starts interactive PowerShell with UTF-8 console and pipe encodings', () => {
    expect(utf8ShellArgs('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo'])).toEqual(['-NoLogo', '-NoExit', '-Command', expect.stringContaining('$OutputEncoding=')])
    expect(utf8ShellArgs('pwsh', ['-NoLogo'])[3]).toContain('[Console]::OutputEncoding=')
    expect(utf8ShellArgs('pwsh', ['-File', 'x.ps1'])).toEqual(['-File', 'x.ps1'])
    expect(utf8ShellArgs('/bin/bash', ['-l'])).toEqual(['-l'])
  })

  it('gives every terminal Python UTF-8 mode', () => {
    expect(terminalEnv({}, {})).toMatchObject({ PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' })
  })

  it('tells units how to append a UTF-8 status line from Windows PowerShell', () => {
    expect(appendCommandPowerShell('C:\\a\\b.status', "note: it's done")).toBe(`Add-Content -Encoding utf8 -LiteralPath "C:/a/b.status" -Value 'note: it''s done'`)
    const brief = renderBrief({ taskId: 't', kind: 'ship', project: 'p', intent: 'x', worktree: 'C:/w', branch: 'b', baseBranch: 'main', statusFile: 'C:/s.status', inboxDir: 'C:/i', taskDataDir: 'C:/d' } as BriefInput)
    expect(brief).toContain('Add-Content -Encoding utf8 -LiteralPath "C:/s.status"')
  })
})
