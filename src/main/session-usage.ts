import path from 'node:path'
import { readJson, writeJsonAtomic } from './util'
import { claudeLimits, readClaudeLimits, type ClaudeLimitsFile, type ClaudeRateLimitInfo } from './usage'
import { isClaudeLimit } from './claude-limit'
import { QUOTA_EVIDENCE_TTL } from '@shared/dispatch'
import type { UsageWindow } from '@shared/api'

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
  constructor(private readonly data: string, private readonly protection = true) { this.file = path.join(data, 'usage', 'claude-backoff.json') }

  private read(): BackoffState {
    const state = readJson<BackoffState>(this.file, { rejections: {}, notices: {} })
    const hadRejections = Object.keys(state.rejections).length > 0
    // Also migrate previously recorded SDK rejections, including after an app restart.
    let limits: ClaudeLimitsFile
    try { limits = readClaudeLimits(this.data) ?? { windows: {} } } catch { limits = { windows: {} } }
    const planAt = Date.parse(limits.planObservedAt ?? '')
    for (const [key, rejection] of Object.entries(state.rejections)) {
      const recovered = limits.planAvailable === false || (key === 'error' || key === 'unspecified'
        ? Object.values(limits.windows ?? {}).length > 0 && Object.values(limits.windows).every(w => w.utilization !== undefined && w.utilization < 0.85)
        : limits.windows[key]?.utilization !== undefined && limits.windows[key].utilization! < 0.85)
      if (planAt > rejection.at && recovered) delete state.rejections[key]
    }
    for (const [key, w] of Object.entries(limits.windows ?? {})) {
      const observed = Date.parse(w.observedAt ?? w.updatedAt)
      if (w.status === 'allowed' || w.status === 'allowed_warning') {
        for (const candidate of [key, 'error']) {
          if (state.rejections[candidate] && observed > state.rejections[candidate].at) delete state.rejections[candidate]
        }
      }
      if (w.status === 'rejected' && !state.rejections[key] && !(Date.parse(w.observedAt ?? w.updatedAt) <= (state.acceptedAt ?? 0))) state.rejections[key] = {
        at: Date.parse(w.observedAt ?? w.updatedAt), reset: w.resetsAt ? w.resetsAt * 1000 : undefined
      }
    }
    if (!Object.keys(state.rejections).length) {
      if (hadRejections) state.notices = {}
      state.probeAt = undefined
      state.probeOwner = undefined
    }
    return state
  }

  observe(info: ClaudeRateLimitInfo, now = Date.now()): void {
    const state = this.read()
    const key = info.rateLimitType || 'unspecified'
    if (info.status === 'rejected') {
      const reset = info.resetsAt ? info.resetsAt * 1000 : state.rejections[key]?.reset
      state.rejections[key] = { at: now, reset }
    } else if (info.status === 'allowed' || info.status === 'allowed_warning') {
      delete state.rejections[key]
      delete state.rejections.error
      if (!Object.keys(state.rejections).length) {
        state.probeAt = undefined
        state.probeOwner = undefined
        state.notices = {}
      }
    }
    writeJsonAtomic(this.file, state)
  }

  rejectError(text: string, now = Date.now()): void {
    if (!isQuotaError(text)) return
    const state = this.read()
    if (!Object.keys(state.rejections).length) state.rejections.error = { at: now }
    writeJsonAtomic(this.file, state)
  }

  canStart(player: boolean, now = Date.now(), claim = true, owner = 'foreground'): boolean {
    const state = this.read()
    const rejections = Object.values(state.rejections)
    if (rejections.length) {
      if (!player || state.probeAt !== undefined || rejections.some((r) => !r.reset || r.reset > now)) return false
      // After reset only one explicit foreground probe across all sessions is allowed.
      if (claim) { state.probeAt = now; state.probeOwner = owner; writeJsonAtomic(this.file, state) }
      return true
    }
    if (!player && this.protection) {
      let windows: UsageWindow[]
      try { windows = claudeLimits(readClaudeLimits(this.data), now)?.windows ?? [] } catch { windows = [] }
      if (windows.some((w) => (w.usedPercent ?? 0) >= 95)) return false
    }
    return true
  }

  /** Status delivery bypasses percentage protection; actual provider rejection backoff remains. */
  canStartTurn(kind: 'player' | 'system' | 'events', now = Date.now(), claim = true, owner = 'foreground'): boolean {
    return kind === 'events' ? !Object.keys(this.read().rejections).length : this.canStart(kind === 'player', now, claim, owner)
  }

  unitBlocked(now = Date.now()): boolean {
    return Object.values(this.read().rejections).some(r => Number.isFinite(r.at) && r.at <= now && now - r.at <= QUOTA_EVIDENCE_TTL && !(r.reset !== undefined && r.reset <= now))
  }

  limitState(): { resetsAt?: number; restartRequired?: boolean; reason?: string } {
    const rejections = Object.values(this.read().rejections)
    if (!rejections.length) return { reason: 'Background work is waiting for a newer Claude usage report. You can still send a message or choose another provider.' }
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
    writeJsonAtomic(this.file, state)
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
    writeJsonAtomic(this.file, state)
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
    writeJsonAtomic(this.file, state)
    return { duplicate: false, delta }
  }
}
