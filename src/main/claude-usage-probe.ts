import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { claudeLimitsFile, type ClaudeLimitsFile } from './usage'
import { claudeEnv } from './claude-home'
import { readJson, writeJsonAtomic } from './util'

const PROBE_TTL = 60_000
const PROBE_TIMEOUT = 25_000
const SOURCE = 'Claude Code /usage (account plan, used percent)'
const probes = new Map<string, { at: number; error?: string; pending?: Promise<void> }>()

/** Parse only plan windows. Session/context/token counters are never plan percentages. */
export function parseClaudePlanUsage(value: unknown, at: string): ClaudeLimitsFile {
  if (!value || typeof value !== 'object') throw new Error('Invalid Claude /usage response')
  const report = value as Record<string, unknown>
  if (typeof report.rate_limits_available !== 'boolean') throw new Error('Missing Claude /usage availability')
  const file: ClaudeLimitsFile = { windows: {}, planObservedAt: at, planAvailable: report.rate_limits_available,
    plan: typeof report.subscription_type === 'string' ? report.subscription_type : undefined }
  if (!report.rate_limits_available) return file // API-key/third-party accounts have no subscription quota.
  if (!report.rate_limits || typeof report.rate_limits !== 'object') throw new Error('Missing Claude plan windows')
  const limits = report.rate_limits as Record<string, unknown>
  const add = (type: string, raw: unknown, label?: string): void => {
    if (raw == null) return
    if (typeof raw !== 'object') throw new Error('Invalid Claude plan window')
    const w = raw as Record<string, unknown>
    if (w.utilization == null) return
    if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization) || w.utilization < 0 || w.utilization > 100)
      throw new Error('Invalid Claude plan used percentage')
    const reset = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN
    file.windows[type] = { source: SOURCE, label, utilization: w.utilization / 100,
      resetsAt: Number.isFinite(reset) ? reset / 1000 : undefined,
      updatedAt: at, observedAt: at, utilizationObservedAt: at, changedAt: at }
  }
  for (const type of ['five_hour', 'seven_day', 'seven_day_oauth_apps', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included']) add(type, limits[type])
  if (limits.model_scoped != null) {
    if (!Array.isArray(limits.model_scoped)) throw new Error('Invalid Claude model windows')
    for (const raw of limits.model_scoped) {
      if (!raw || typeof raw !== 'object' || typeof raw.display_name !== 'string') throw new Error('Invalid Claude model window')
      add(`model:${raw.display_name}`, raw, `weekly (${raw.display_name})`)
    }
  }
  return file
}

/** No model prompt, token-count call, credentials read or direct OAuth request. */
export async function probeClaudePlanUsage(cwd: string, executable?: string): Promise<unknown> {
  let q: Query | undefined
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  async function* input(): AsyncGenerator<never> { await hold }
  let timer: ReturnType<typeof setTimeout> | undefined
  let finished = false
  try {
    return await Promise.race([
      (async () => {
        const { query } = await import('@anthropic-ai/claude-agent-sdk')
        // Plan usage belongs to the account, so Genio's own Claude home reports the same windows.
        const env = { ...process.env, ...(await claudeEnv()) }
        if (finished) throw new Error('Claude /usage cancelled')
        q = query({ prompt: input(), options: { cwd, settingSources: [], tools: [], mcpServers: {}, persistSession: false, env,
          ...(executable ? { pathToClaudeCodeExecutable: executable } : {}) } })
        const usage = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
        if (typeof usage !== 'function') throw new Error('Structured Claude /usage unavailable')
        return usage.call(q, { skipBehaviors: true })
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Claude /usage timed out')), PROBE_TIMEOUT) })
    ])
  } finally { finished = true; clearTimeout(timer); try { q?.close() } finally { release() } }
}

/** Single-flight per account home; failed refreshes never renew evidence timestamps. */
export async function refreshClaudePlanUsage(data: string, cwd: string, executable?: string, force = false): Promise<void> {
  const prior = probes.get(data)
  if (prior?.pending) return prior.pending
  if (!force && prior && Date.now() - prior.at < PROBE_TTL) return
  const state: { at: number; error?: string; pending?: Promise<void> } = { at: Date.now() }
  probes.set(data, state)
  state.pending = (async () => {
    try {
      const value = await probeClaudePlanUsage(cwd, executable)
      // A successful account snapshot replaces all old-account/window evidence.
      const next = parseClaudePlanUsage(value, new Date().toISOString())
      const prior = readJson<ClaudeLimitsFile>(claudeLimitsFile(data), { windows: {} })
      for (const [type, w] of Object.entries(next.windows)) {
        const old = prior.windows?.[type]
        if (prior.plan === next.plan && old?.utilization === w.utilization && old?.resetsAt === w.resetsAt)
          w.changedAt = old.changedAt ?? old.updatedAt
      }
      writeJsonAtomic(claudeLimitsFile(data), next)
    } catch {
      // Provider errors can contain sensitive data. Show a bounded, credential-free reason.
      state.error = 'Claude /usage refresh failed; current usage may be unknown. Retrying automatically.'
    } finally { state.pending = undefined }
  })()
  return state.pending
}

export const claudeProbeError = (data: string): string | undefined => probes.get(data)?.error
