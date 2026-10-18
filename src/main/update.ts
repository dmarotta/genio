import { app } from 'electron'
import type { UpdateInfo } from '@shared/types'
import { bus } from './bus'
import { aheadBehind, currentBranch, git, isRepo, statusPorcelain } from './git'
import type { AppCtx, UpdateService } from './services'
import { runShell } from './util'

/**
 * /patch: guarded, fast-forward-only self update
 * of the Genio checkout, then restart every Genio session and relaunch.
 * Never touches worlds.
 */
export function createUpdateService(getCtx: () => AppCtx): UpdateService {
  const root = (): string => getCtx().appRoot

  async function check(): Promise<UpdateInfo> {
    const dir = root()
    if (!(await isRepo(dir))) {
      return { isGitCheckout: false, behind: 0, ahead: 0, dirty: false, incoming: [], canFastForward: false }
    }
    const branch = await currentBranch(dir)
    const dirty = (await statusPorcelain(dir)).filter((l) => !l.startsWith('??')).length > 0
    const fetched = await git(dir, ['fetch', '--quiet', 'origin'], 120_000)
    if (fetched.code !== 0) {
      return {
        isGitCheckout: true, branch, behind: 0, ahead: 0, dirty, incoming: [], canFastForward: false,
        error: fetched.stderr.trim() || 'no origin remote to patch from'
      }
    }
    const upstream = `origin/${branch}`
    const has = await git(dir, ['rev-parse', '--verify', '--quiet', upstream])
    if (has.code !== 0) {
      return { isGitCheckout: true, branch, behind: 0, ahead: 0, dirty, incoming: [], canFastForward: false, error: `no ${upstream} to patch from` }
    }
    const { ahead, behind } = await aheadBehind(dir, 'HEAD', upstream)
    const log = await git(dir, ['log', '--oneline', '-n30', `HEAD..${upstream}`])
    const incoming = log.code === 0 ? log.stdout.split(/\r?\n/).filter(Boolean) : []
    return { isGitCheckout: true, branch, behind, ahead, dirty, incoming, canFastForward: behind > 0 && ahead === 0 && !dirty }
  }

  async function apply(): Promise<{ ok: boolean; message: string }> {
    const info = await check()
    if (!info.isGitCheckout) return { ok: false, message: 'Genio is not running from a git checkout, so there is nothing to patch from.' }
    if (info.error) return { ok: false, message: info.error }
    if (info.behind === 0) return { ok: true, message: 'Already on the latest patch.' }
    if (info.dirty) return { ok: false, message: 'The Genio checkout has local edits; patching stopped so nothing is lost.' }
    if (info.ahead > 0) return { ok: false, message: `The Genio checkout has ${info.ahead} local commit(s) not on origin; patching only fast-forwards, so it stopped.` }
    const dir = root()
    const before = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim()
    const ff = await git(dir, ['merge', '--ff-only', `origin/${info.branch}`])
    if (ff.code !== 0) return { ok: false, message: `Fast-forward failed: ${ff.stderr.trim()}` }
    const changed = await git(dir, ['diff', '--name-only', before, 'HEAD'])
    if (/package-lock\.json|package\.json/.test(changed.stdout)) {
      bus.toast('info', 'Patching', 'Installing updated dependencies…')
      const npm = await runShell('npm install', { cwd: dir, timeoutMs: 900_000 })
      if (npm.code !== 0) return { ok: false, message: `Patched code, but npm install failed: ${npm.stderr.slice(-400)}` }
    }
    const ctx = getCtx()
    for (const h of ctx.homes.values()) {
      await h.wksp.stop().catch(() => undefined)
      await h.design?.stop().catch(() => undefined)
    }
    bus.toast('success', 'Patch applied', `${info.behind} update(s). Restarting Genio…`)
    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 800)
    return { ok: true, message: `Patched ${info.behind} commit(s): ${info.incoming.slice(0, 5).join('; ')}. Restarting.` }
  }

  return { check, apply }
}
