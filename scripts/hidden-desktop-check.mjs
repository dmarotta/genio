// Manual check of Genio's hidden desktop on this machine (Windows). Unit tests use a fake desktop only;
// this runs the real helper. From the Genio checkout:
//
//   node scripts/hidden-desktop-check.mjs
//   node scripts/hidden-desktop-check.mjs --unity D:\scratch\SomeProject [--editor "C:\...\Unity.exe"] [--seconds 120]
//
// Without --unity it builds the helper with the Windows C# compiler, then starts a small PowerShell
// message box on a hidden desktop three times: it checks that nothing appears on your desktop, that the
// recorded PID and creation time match Windows' process list, that the watcher presses a safe button,
// that an unknown dialog blocks with a screenshot, and that the desktop is cleaned up when the process
// exits. With --unity it also opens that project's Unity editor on a hidden desktop (use a project no
// editor has open, ideally a throwaway copy), watches it for dialogs, then quits it. Everything it
// writes lives under %TEMP%\genio-hidden-desktop-check-* and is deleted at the end unless --keep.
// PASSED (exit 0) means Genio can launch slot editors hidden on this machine.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDesktopApi, cscPath, inspectDesktop, launchEditor, DIALOG_RULES } from '../resources/unit-skills/genio/lib/hidden-desktop.mjs'
import { listProcesses } from '../resources/unit-skills/genio/skills/play/scripts/pool.mjs'

const argv = process.argv.slice(2)
const option = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
const keep = argv.includes('--keep')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
let failed = 0
const check = (ok, label, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`); if (!ok) failed++; return ok }

if (process.platform !== 'win32') { console.log('Hidden desktops exist only on Windows; Genio opens slot editors visibly here.'); process.exit(0) }
console.log(`Windows ${os.release()}, C# compiler: ${cscPath() ?? 'missing'}`)
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-hidden-desktop-check-'))
const api = createDesktopApi(data)
const TITLE = 'Genio hidden desktop check'
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const boxArgs = ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show('If you can see this, the hidden desktop leaked.', '${TITLE}', 'OKCancel')`]
const ownWindowsOnUserDesktop = async pid => ((await api.windows('Default').catch(() => [])) ?? []).filter(w => w.pid === pid)
async function waitFor(fn, ms = 20000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(500) } }
async function exited(pid, ms = 15000) { return waitFor(async () => !alive(pid), ms) }

try {
  // 1. Launch: identity, invisibility, the dialog on the hidden desktop.
  const first = await launchEditor({ file: powershell, args: boxArgs, data, label: 'check' })
  if (!check(first.hidden, 'launched on a hidden desktop', first.warning ?? first.desktop)) throw new Error('no hidden desktop')
  const listed = (await listProcesses()).find(p => p.pid === first.pid)
  check(listed?.created === first.created, 'recorded PID and creation time match the Windows process list', `${first.pid} @ ${first.created}`)
  const box = await waitFor(async () => (await api.windows(first.desktop))?.find(w => w.title === TITLE))
  check(!!box, 'the dialog exists on the hidden desktop', box && `buttons ${box.buttons.join(', ')}`)
  check((await ownWindowsOnUserDesktop(first.pid)).length === 0, 'no window of that process on your desktop')
  // 2. A benign dialog: the watcher presses its safe button and the desktop goes away with the process.
  const benign = [{ id: 'check', kind: 'benign', match: new RegExp(TITLE), button: ['Cancel'] }, ...DIALOG_RULES]
  const pass = await inspectDesktop(api, first, { rules: benign })
  check(pass.clicked.some(c => c.button === 'Cancel'), 'the watcher pressed the safe button')
  check(await exited(first.pid), 'the process exited after the click')
  check(await waitFor(() => fs.existsSync(path.join(first.dir, 'exit.json'))), 'the helper recorded the exit')
  check(await waitFor(async () => (await api.windows(first.desktop).catch(() => null)) === null), 'the hidden desktop was removed')
  // 3. An unknown dialog: blocks after the grace period, with a screenshot; WM_CLOSE through the helper ends it.
  const second = await launchEditor({ file: powershell, args: boxArgs, data, label: 'check' })
  await waitFor(async () => (await api.windows(second.desktop))?.some(w => w.title === TITLE))
  await inspectDesktop(api, second, { graceMs: 1000 })
  await sleep(1200)
  const blocked = (await inspectDesktop(api, second, { graceMs: 1000 })).blocked
  check(!!blocked, 'an unknown dialog is reported as blocking', blocked?.message)
  check(!!blocked?.screenshot && fs.statSync(blocked.screenshot).size > 0, 'a screenshot of the hidden desktop was saved', blocked?.screenshot)
  check(await api.close(second.desktop, second.pid), 'WM_CLOSE reached the window on the hidden desktop')
  check(await exited(second.pid), 'the process closed')

  // 4. Optional: the real Unity editor.
  const project = option('unity')
  if (project) {
    const root = path.resolve(project)
    const version = fs.readFileSync(path.join(root, 'ProjectSettings/ProjectVersion.txt'), 'utf8').match(/^m_EditorVersion:\s*([\w.]+)/m)?.[1]
    const editor = option('editor') ?? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Unity/Hub/Editor', version ?? '', 'Editor/Unity.exe')
    if (!fs.existsSync(editor)) throw new Error(`No Unity editor at ${editor}; pass --editor`)
    if (fs.existsSync(path.join(root, 'Temp/UnityLockfile'))) throw new Error(`${root} looks open in another editor (Temp/UnityLockfile); close it first`)
    const seconds = Number(option('seconds') ?? 120)
    const unity = await launchEditor({ file: editor, args: ['-automated', '-projectPath', root], data, label: 'unitycheck' })
    check(unity.hidden, 'Unity launched on a hidden desktop', unity.desktop ?? unity.warning)
    let leaked = 0, windows = []
    for (const end = Date.now() + seconds * 1000; Date.now() < end && alive(unity.pid);) {
      const r = await inspectDesktop(api, unity)
      for (const c of r.clicked) console.log(`     pressed "${c.button}" on "${c.title}"`)
      if (r.blocked) { console.log(`     ${r.blocked.message}`); break }
      windows = (await api.windows(unity.desktop)) ?? []
      leaked = Math.max(leaked, (await ownWindowsOnUserDesktop(unity.pid)).length)
      await sleep(5000)
    }
    console.log(`     windows on the hidden desktop: ${windows.map(w => `"${w.title}" [${w.className}]`).join(', ') || 'none'}`)
    check(leaked === 0, 'Unity showed no window on your desktop')
    check(windows.some(w => /Unity/.test(w.title ?? '')), 'the editor window exists on the hidden desktop')
    await api.close(unity.desktop, unity.pid)
    for (let i = 0; i < 12 && alive(unity.pid); i++) { await inspectDesktop(api, unity, { benignOnly: true }); await sleep(5000) }
    if (!check(!alive(unity.pid), 'Unity quit through WM_CLOSE on its hidden desktop')) { process.kill(unity.pid); console.log('     stopped it') }
  }
} catch (e) {
  check(false, e.message)
} finally {
  if (!keep) fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  else console.log(`Kept ${data}`)
}
console.log(failed ? `FAILED (${failed})` : 'PASSED')
process.exitCode = failed ? 1 : 0
