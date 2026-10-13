import path from 'node:path'
import { readJson, writeJson } from './util'
import { claudeLimits, claudeLimitsFile, type ClaudeLimitsFile, type ClaudeRateLimitInfo } from './usage'
import { isClaudeLimit } from './claude-limit'

interface Rejection { at: number; reset?: number }
interface BackoffState {
  rejections: Record<string, Rejection>
  probeAt?: number
  probeOwner?: string
  acceptedAt?: number
  notices: Record<string, string[]>
}

export const isQuotaError = (text: string): boolean => isClaudeLimit(text) || /rate.?limit|usage limit|usage_limit|hit your limit|quota exceeded|too many requests|\b429\b/i.test(text)

/** Account-wide, durable gate shared by main chat, allies and Bot. No provider calls. */
export class SessionQuotaPolicy {
  private readonly file: string
  constructor(private readonly data: string) { this.file = path.join(data, 'usage', 'claude-backoff.json') }

  private read(): BackoffState {
    const state = readJson<BackoffState>(this.file, { rejections: {}, notices: {} })
    // Also migrate previously recorded SDK rejections, including after an app restart.
    const limits = readJson<ClaudeLimitsFile>(claudeLimitsFile(this.data), { windows: {} })
    for (const [key, w] of Object.entries(limits.windows ?? {})) {
      if (w.status === 'rejected' && !state.rejections[key] && !(Date.parse(w.observedAt ?? w.updatedAt) <= (state.acceptedAt ?? 0))) state.rejections[key] = {
        at: Date.parse(w.observedAt ?? w.updatedAt), reset: w.resetsAt ? w.resetsAt * 1000 : undefined
      }
    }
    return state
  }

  observe(info: ClaudeRateLimitInfo, now = Date.now()): void {
    const state = this.read()
    const key = info.rateLimitType || 'unspecified'
    if (info.status === 'rejected') {
      const reset = info.resetsAt ? info.resetsAt * 1000 : state.rejections[key]?.reset
      state.rejections[key] = { at: state.rejections[key]?.at ?? now, reset }
    } else if (info.status === 'allowed' || info.status === 'allowed_warning') {
      delete state.rejections[key]
      delete state.rejections.error
      if (!Object.keys(state.rejections).length) {
        state.probeAt = undefined
        state.probeOwner = undefined
        state.notices = {}
      }
    }
    writeJson(this.file, state)
  }

  rejectError(text: string, now = Date.now()): void {
    if (!isQuotaError(text)) return
    const state = this.read()
    if (!Object.keys(state.rejections).length) state.rejections.error = { at: now }
    writeJson(this.file, state)
  }

  canStart(player: boolean, now = Date.now(), claim = true, owner = 'foreground'): boolean {
    const state = this.read()
    const rejections = Object.values(state.rejections)
    if (rejections.length) {
      if (!player || state.probeAt !== undefined || rejections.some((r) => !r.reset || r.reset > now)) return false
      // After reset only one explicit foreground probe across all sessions is allowed.
      if (claim) { state.probeAt = now; state.probeOwner = owner; writeJson(this.file, state) }
      return true
    }
    if (!player) {
      const windows = claudeLimits(readJson<ClaudeLimitsFile | undefined>(claudeLimitsFile(this.data), undefined), now)?.windows ?? []
      if (windows.some((w) => (w.usedPercent ?? w.lastKnownUsedPercent ?? 0) >= 95)) return false
    }
    return true
  }

  unitBlocked(): boolean { return Object.keys(this.read().rejections).length > 0 }

  limitState(): { resetsAt?: number; restartRequired?: boolean } {
    const rejections = Object.values(this.read().rejections)
    const resets = rejections.map((r) => r.reset)
    const resetsAt = resets.length && resets.every((r) => r !== undefined) ? Math.max(...resets as number[]) : undefined
    return { resetsAt, restartRequired: resetsAt === undefined || resetsAt <= Date.now() }
  }

  /** Collapse SDK error/result/notice variants into one notice per rejection episode. */
  notice(channel: string, text: string): boolean {
    const state = this.read()
    const key = isQuotaError(text) ? 'quota-rejected' : text.trim()
    const seen = state.notices[channel] ?? []
    if (seen.includes(key)) return false
    state.notices[channel] = [...seen, key].slice(-100)
    writeJson(this.file, state)
    return true
  }

  succeeded(channel: string): void {
    const state = this.read()
    delete state.notices[channel]
    if (state.probeAt !== undefined && state.probeOwner === channel) {
      for (const [key, r] of Object.entries(state.rejections)) {
        if (r.reset !== undefined && r.reset <= state.probeAt) delete state.rejections[key]
      }
      state.acceptedAt = Date.now()
      state.probeAt = undefined
      state.probeOwner = undefined
    }
    writeJson(this.file, state)
  }
}

interface CostEpoch { total?: number; epoch: number; results: string[] }
interface CostState { sessions: Record<string, CostEpoch> }

/** Persist cumulative checkpoints before emitting deltas. An unknown resumed
 * baseline is seeded without charging historical usage to the first new turn. */
export class SessionCostLedger {
  constructor(private readonly file: string) {}

  record(session: string, result: string, total: number | undefined, resumed: boolean): { duplicate: boolean; delta: number } {
    const state = readJson<CostState>(this.file, { sessions: {} })
    const prior = state.sessions[session]
    if (result && prior?.results.includes(result)) return { duplicate: true, delta: 0 }
    const epoch: CostEpoch = prior ?? { epoch: 0, results: [] }
    let delta = 0
    if (typeof total === 'number' && Number.isFinite(total) && total >= 0) {
      if (epoch.total === undefined) delta = resumed ? 0 : total
      else if (total >= epoch.total) delta = total - epoch.total
      else { epoch.epoch++; delta = total }
      epoch.total = total
    }
    if (result) epoch.results.push(result)
    state.sessions[session] = epoch
    writeJson(this.file, state)
    return { duplicate: false, delta }
  }
}
