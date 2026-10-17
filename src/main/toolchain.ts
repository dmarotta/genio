/**
 * Systems check: which CLIs exist on this machine, and consent-gated installs
 * (companion "detects and offers to install supported missing tools after you approve").
 */
import { Worker } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import type { ToolStatus } from '@shared/types'
import type { OpResult } from '@shared/api'
import type { AppCtx, ToolchainService } from './services'
import { findBlender } from '../../resources/unit-skills/genio/lib/blender-path.mjs'
import { pluginFile } from '../../resources/unit-skills/genio/lib/resource-path.mjs'
import { bus } from './bus'
import { clearWhichCache, run, runShell, which } from './util'

/**
 * findBlender reads the registry and asks each candidate for its version with synchronous child processes
 * (about 1.3 s on Windows), so a check runs that same module on a worker thread and the main process keeps
 * serving the windows. Where no worker can run it, it runs here as before.
 */
export function findBlenderOffThread(): Promise<string | null> {
  let file: string
  try { file = pluginFile('lib/blender-path.mjs') } catch { return Promise.resolve(findBlender()) }
  return new Promise((resolve) => {
    let settled = false
    const worker = new Worker(`import(${JSON.stringify(pathToFileURL(file).href)}).then(m => require('node:worker_threads').parentPort.postMessage(m.findBlender()))`, { eval: true })
    const done = (found: unknown): void => {
      if (settled) return
      settled = true
      void worker.terminate()
      resolve(typeof found === 'string' || found === null ? found : findBlender())
    }
    worker.once('message', done)
    worker.once('error', () => done(undefined))
    worker.once('exit', () => done(undefined))
  })
}

interface ToolDef {
  name: string
  probe?: () => Promise<string | null>
  /** The same probe for has(), which answers synchronously. */
  probeSync?: () => string | null
  purpose: string
  required: boolean
  versionArgs: string[]
  winget?: string
  npm?: string
  brew?: string
}

const TOOLS: ToolDef[] = [
  { name: 'blender', purpose: 'Batch 3D modelling, mesh validation and export', required: false, versionArgs: ['--version'], winget: 'BlenderFoundation.Blender', probe: findBlenderOffThread, probeSync: findBlender },
  { name: 'git', purpose: 'Worktrees, branches and merges for every project', required: true, versionArgs: ['--version'], winget: 'Git.Git', brew: 'git' },
  { name: 'gh', purpose: 'GitHub pull requests, checks and merges', required: false, versionArgs: ['--version'], winget: 'GitHub.cli', brew: 'gh' },
  { name: 'glab', purpose: 'GitLab merge requests (best effort)', required: false, versionArgs: ['--version'], winget: 'GLab.GLab', brew: 'glab' },
  { name: 'claude', purpose: 'Claude Code units (default)', required: true, versionArgs: ['--version'], npm: '@anthropic-ai/claude-code' },
  { name: 'codex', purpose: 'Codex CLI units', required: false, versionArgs: ['--version'], npm: '@openai/codex' },
  { name: 'gemini', purpose: 'Gemini CLI units', required: false, versionArgs: ['--version'], npm: '@google/gemini-cli' },
  { name: 'opencode', purpose: 'OpenCode units', required: false, versionArgs: ['--version'], npm: 'opencode-ai' },
  { name: 'cursor-agent', purpose: 'Cursor Agent units', required: false, versionArgs: ['--version'] },
  { name: 'grok', purpose: 'Grok CLI units', required: false, versionArgs: ['--version'] },
  { name: 'aider', purpose: 'Aider units', required: false, versionArgs: ['--version'] },
  { name: 'node', purpose: 'Runs hooks and web-game tooling', required: true, versionArgs: ['--version'], winget: 'OpenJS.NodeJS.LTS', brew: 'node' },
  { name: 'npm', purpose: 'Installs CLI units and web-game packages', required: false, versionArgs: ['--version'] },
  { name: 'godot', purpose: 'Godot headless checks and playtests', required: false, versionArgs: ['--version'], winget: 'GodotEngine.GodotEngine', brew: 'godot' }
]

function installHint(t: ToolDef): string | undefined {
  if (t.npm) return `npm install -g ${t.npm}`
  if (process.platform === 'win32' && t.winget) return `winget install --id ${t.winget} -e`
  if (t.brew) return `brew install ${t.brew}`
  return undefined
}

async function probeTool(t: ToolDef): Promise<ToolStatus> {
  const p = t.probe ? await t.probe() : which(t.name)
  const st: ToolStatus = { name: t.name, found: Boolean(p), path: p ?? undefined, required: t.required, purpose: t.purpose, install: installHint(t) }
  if (p) {
    const r = /\.(cmd|bat)$/i.test(p)
      ? await runShell(`"${p}" ${t.versionArgs.join(' ')}`, { timeoutMs: 15_000 })
      : await run(p, t.versionArgs, { timeoutMs: 15_000 })
    const v = (r.stdout || r.stderr).trim().split(/\r?\n/)[0]
    if (v) st.version = v.slice(0, 120)
  }
  return st
}

/** Loadout detection for one known tool (undefined for tools outside the loadout). */
export function toolStatus(name: string): Promise<ToolStatus> | undefined {
  const t = TOOLS.find((x) => x.name === name)
  return t ? probeTool(t) : undefined
}

export function createToolchainService(_getCtx: () => AppCtx): ToolchainService {
  const found = new Map<string, boolean>()

  const probe = async (t: ToolDef): Promise<ToolStatus> => {
    const st = await probeTool(t)
    found.set(t.name, st.found)
    return st
  }

  const svc: ToolchainService = {
    async check() {
      clearWhichCache()
      return Promise.all(TOOLS.map(probe))
    },
    has(name) {
      if (!found.has(name)) {
        const t = TOOLS.find(x => x.name === name)
        found.set(name, Boolean(t?.probeSync ? t.probeSync() : which(name)))
      }
      return found.get(name) ?? false
    },
    async install(name): Promise<OpResult> {
      const t = TOOLS.find((x) => x.name === name)
      if (!t) return { ok: false, message: `Unknown tool: ${name}` }
      const hint = installHint(t)
      if (!hint) return { ok: false, message: `${name} has no automatic installer; install it manually.` }
      bus.toast('info', `Installing ${name}`, hint)
      const r = await runShell(hint, { timeoutMs: 15 * 60_000 })
      clearWhichCache()
      found.delete(name)
      const ok = r.code === 0 && svc.has(name)
      const tailOut = (r.stdout + r.stderr).trim().split(/\r?\n/).slice(-6).join('\n')
      bus.toast(ok ? 'success' : 'error', ok ? `${name} installed` : `${name} install failed`, ok ? undefined : tailOut)
      return {
        ok,
        message: ok
          ? `${name} installed.`
          : `Install of ${name} did not finish cleanly (exit ${r.code}). ${r.code === 0 ? 'It may need a new terminal/PATH refresh. ' : ''}${tailOut}`
      }
    }
  }
  return svc
}
