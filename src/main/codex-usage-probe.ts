/**
 * Codex plan usage, read on demand. Session logs only carry a rate-limit
 * snapshot while Codex is running, so an idle machine has no evidence under
 * the 10-minute quota TTL. This asks the signed-in Codex app-server directly
 * (account/rateLimits/read): no thread, no model prompt, no credentials read.
 */
import path from 'node:path'
import { spawnCodexChat, type CodexRpc, type CodexWireEvents } from './codex-chat-driver'
import { CodexNeedsSignIn, codexEnv, codexSignedOut } from './codex-home'
import type { CodexSnapshot, CodexWindow } from './usage'
import { readJson, writeJsonAtomic } from './util'

const PROBE_TTL = 60_000
const PROBE_TIMEOUT = 25_000
export const CODEX_PROBE_SOURCE = 'Codex app-server account/rateLimits/read (account plan, used percent)'
const probes = new Map<string, { at: number; error?: string; pending?: Promise<void> }>()

/** A reason that is safe to show: never provider text, which can carry account data. */
export class CodexUsageError extends Error {}

export const codexLimitsFile = (dataDir: string): string => path.join(dataDir, 'usage', 'codex-limits.json')
export const readCodexProbeLimits = (dataDir: string): CodexSnapshot[] => {
  const v = readJson<unknown>(codexLimitsFile(dataDir), [])
  return Array.isArray(v) ? (v as CodexSnapshot[]) : []
}

type Raw = Record<string, unknown>
const isObj = (v: unknown): v is Raw => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

function window(raw: unknown): CodexWindow | undefined {
  if (raw == null) return undefined
  if (!isObj(raw)) throw new CodexUsageError('Codex rate-limit report has an unexpected format')
  // usedPercent is USED (0 = untouched); the meter inverts it exactly once.
  if (typeof raw.usedPercent !== 'number' || !Number.isFinite(raw.usedPercent) || raw.usedPercent < 0)
    throw new CodexUsageError('Codex rate-limit report has an unexpected format')
  return {
    minutes: typeof raw.windowDurationMins === 'number' ? raw.windowDurationMins : undefined,
    usedPercent: raw.usedPercent,
    resetsAt: typeof raw.resetsAt === 'number' && Number.isFinite(raw.resetsAt) ? new Date(raw.resetsAt * 1000).toISOString() : undefined
  }
}

/** One app-server rate-limit object (also the account/rateLimits/updated payload) as a snapshot. */
export function codexSnapshot(raw: unknown, at: string, source?: string): CodexSnapshot | undefined {
  if (!isObj(raw)) throw new CodexUsageError('Codex rate-limit report has an unexpected format')
  const windows = [window(raw.primary), window(raw.secondary)].filter((w): w is CodexWindow => Boolean(w))
  if (!windows.length) return undefined
  return { ts: at, limitId: typeof raw.limitId === 'string' && raw.limitId ? raw.limitId : 'codex',
    name: typeof raw.limitName === 'string' && raw.limitName ? raw.limitName : undefined,
    plan: typeof raw.planType === 'string' && raw.planType ? raw.planType : undefined, windows, source }
}

/** The account/rateLimits/read result: every limit bucket, else the single legacy one. */
export function parseCodexRateLimits(result: unknown, at: string): CodexSnapshot[] {
  if (!isObj(result)) throw new CodexUsageError('Codex rate-limit report has an unexpected format')
  const buckets = isObj(result.rateLimitsByLimitId) ? Object.values(result.rateLimitsByLimitId) : result.rateLimits != null ? [result.rateLimits] : undefined
  if (!buckets) throw new CodexUsageError('Codex rate-limit report has an unexpected format')
  return buckets.map((b) => codexSnapshot(b, at, CODEX_PROBE_SOURCE)).filter((s): s is CodexSnapshot => Boolean(s))
}

/**
 * initialize → account/read → account/rateLimits/read on a short-lived app-server
 * in Genio's own Codex home. Not signed in there (or an API-key login, which has
 * no plan usage) throws CodexNeedsSignIn before any process starts: the probe
 * never touches the player's own ~/.codex.
 */
export async function probeCodexRateLimits(wire?: (events: CodexWireEvents) => CodexRpc): Promise<unknown> {
  if (!wire) {
    const env = await codexEnv()
    wire = events => spawnCodexChat(events, env)
  }
  let rpc: CodexRpc
  try {
    rpc = wire({ notification() {}, request: () => Promise.reject(new Error('unsupported')), closed() {} })
  } catch {
    throw new CodexUsageError('Codex CLI not found')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        await rpc.request('initialize', { clientInfo: { name: 'genio_usage', version: '1.0' } })
        rpc.notify('initialized', {})
        const account = await rpc.request('account/read', { refreshToken: false })
        if (!['chatgpt', 'chatgptAuthTokens'].includes(account.account?.type))
          throw new CodexUsageError('Codex is not signed in with ChatGPT, so there is no plan usage to read')
        return rpc.request('account/rateLimits/read', {})
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CodexUsageError('Codex rate-limit read timed out')), PROBE_TIMEOUT) })
    ])
  } finally { clearTimeout(timer); rpc.close() }
}

/** Single-flight per data dir; a failed refresh keeps old evidence on its original observation clock. */
export async function refreshCodexPlanUsage(data: string, force = false, probe: () => Promise<unknown> = probeCodexRateLimits): Promise<void> {
  // Not signed in (checked): nothing to read and nothing to report, no probe and no error.
  if (codexSignedOut()) { probes.delete(data); return }
  const prior = probes.get(data)
  if (prior?.pending) return prior.pending
  if (!force && prior && Date.now() - prior.at < PROBE_TTL) return
  const state: { at: number; error?: string; pending?: Promise<void> } = { at: Date.now() }
  probes.set(data, state)
  state.pending = (async () => {
    try {
      const value = await probe()
      const at = new Date().toISOString()
      // A successful account snapshot replaces every bucket of the previous one.
      writeJsonAtomic(codexLimitsFile(data), parseCodexRateLimits(value, at))
    } catch (error) {
      // Needs sign-in is the Accounts row's to say, not a usage error.
      state.error = error instanceof CodexNeedsSignIn ? undefined : error instanceof CodexUsageError ? error.message : 'Codex rate-limit read failed'
    } finally { state.pending = undefined }
  })()
  return state.pending
}

export const codexProbeError = (data: string): string | undefined => probes.get(data)?.error
