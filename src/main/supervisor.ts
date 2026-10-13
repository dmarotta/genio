/**
 * Overwatch (companion bin/fm-watch.sh): zero-token supervision of one base.
 *
 * A deterministic poll loop that reads unit status files, terminal liveness,
 * steering-inbox acknowledgements, PR state and player-defined triggers, and
 * turns only *actionable* changes into durable events (wakes.ts). Genio's
 * agent is woken through wksp.deliverWakes() — idle overwatch costs no tokens.
 *
 * Event kinds:
 *   signal    new player-relevant status lines (coalesced), or a turn that
 *             ended without a declared status
 *   stale     lagging unit (no output), dead process, unanswered ping
 *   check     PR merged/closed/red/green, paused wait expired, triggers
 *   heartbeat tick: deferred choices resurfacing, quests ready to deploy
 *
 * Every step is wrapped: overwatch must never crash the app.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { EventSource, StatusEvent, Task, WakeKind } from '@shared/types'
import { bus } from './bus'
import type { Home } from './home'
import type { AppCtx, SupervisorService } from './services'
import { runShell, truncate } from './util'

interface Track {
  pendingSignal: StatusEvent[]
  signalSince?: number
  lastDeclaredAt: number
  turnEndSeenMtime: number
  turnEndAt?: number
  turnEndCheckAt?: number
  touchedAt?: number
  staleEscalations: number
  lastStaleWakeAt?: number
  exitedReported: boolean
  pausedSince?: number
  pausedLastSurfaceAt?: number
  pausedUntilFired?: string
  inboxSeq?: number
  inboxRings: number
  inboxLastRingAt?: number
  inboxEscalated: boolean
  prPolledAt?: number
  prBusy: boolean
  prChecks?: string
  prState?: string
}

const LIVE_FOR_STALE = new Set<Task['state']>(['working', 'spawning'])
const EXIT_WATCH = new Set<Task['state']>(['working', 'spawning', 'paused', 'blocked', 'needs-decision', 'validating', 'stale'])
const DECLARED = new Set<StatusEvent['kind']>(['done', 'failed', 'needs-decision', 'blocked', 'paused', 'player-held'])
const TURN_END_SETTLE_MS = 20_000

export function createSupervisor(getCtx: () => AppCtx, home: Home): SupervisorService {
  const tracks = new Map<string, Track>()
  let timer: NodeJS.Timeout | undefined
  let kick: NodeJS.Timeout | undefined
  let running = false
  let pollMs = 15_000
  let dirty = false
  let unsub: (() => void) | undefined

  // tick (heartbeat) state
  let nextTickAt = 0
  let tickStreak = 0
  let lastFleetSig = ''
  let lastDispatchSig = ''

  // triggers state (main base only)
  const triggerBusy = new Set<string>()
  const triggerLastCode = new Map<string, number>()

  const ctx = (): AppCtx => getCtx()
  const hc = () => ctx().home(home.name)
  const settings = () => ctx().settings.get()

  function track(t: Task): Track {
    let tr = tracks.get(t.id)
    if (!tr) {
      tr = {
        pendingSignal: [],
        lastDeclaredAt: t.lastStatusAt ? Date.parse(t.lastStatusAt) || 0 : 0,
        turnEndSeenMtime: turnEndMtime(t.id),
        staleEscalations: 0,
        exitedReported: t.state === 'exited',
        inboxRings: 0,
        inboxEscalated: false,
        prBusy: false,
        prChecks: t.pr?.checks,
        prState: t.pr?.state
      }
      tracks.set(t.id, tr)
    }
    return tr
  }

  function turnEndFile(id: string): string {
    return path.join(home.state, `${id}.turn-ended`)
  }

  function turnEndMtime(id: string): number {
    try {
      return fs.statSync(turnEndFile(id)).mtimeMs
    } catch {
      return 0
    }
  }

  function enqueue(kind: WakeKind, reason: string, taskId: string | undefined, lines: string[], routine: boolean): void {
    try {
      hc().wakes.enqueue({ kind, reason, taskId, lines, routine })
      dirty = true
    } catch {
      /* queue unavailable; next pass retries the condition */
    }
  }

  function deliver(): void {
    if (!dirty) return
    dirty = false
    try {
      hc().wksp.deliverWakes()
    } catch {
      /* wksp not ready; queue is durable */
    }
  }

  function step(name: string, fn: () => void): void {
    try {
      fn()
    } catch (e) {
      // keep overwatch alive; surface nothing to the player for internal glitches
      if (process.env.GENIO_DEBUG) console.error(`[overwatch:${home.name}] ${name}:`, e)
    }
  }

  function lastOutput(t: Task, tr: Track): number {
    let last = 0
    try {
      if (t.terminalId) last = ctx().terminals.lastOutputAt(t.terminalId) ?? 0
    } catch {
      last = 0
    }
    if (!last && t.lastOutputAt) last = Date.parse(t.lastOutputAt) || 0
    if (!last) last = Date.parse(t.updatedAt) || 0
    return Math.max(last, tr.touchedAt ?? 0)
  }

  function tailLines(t: Task, n: number): string[] {
    try {
      if (!t.terminalId) return []
      return ctx()
        .terminals.tail(t.terminalId, n)
        .split(/\r?\n/)
        .map((l) => l.trimEnd())
        .filter((l) => l.trim())
        .slice(-n)
        .map((l) => `| ${truncate(l, 200)}`)
    } catch {
      return []
    }
  }

  const label = (t: Task): string => `${t.kind === 'scout' ? 'RECON' : 'BUILD'} "${t.title}" (${t.project})`

  // ------------------------------------------------------------ (1) status

  function stepStatus(t: Task, tr: Track, now: number, grace: number): void {
    const events = hc().crew.readNewStatus(t.id)
    for (const ev of events) {
      bus.publish({ type: 'status', event: ev })
      tr.staleEscalations = 0
      tr.lastStaleWakeAt = undefined
      if (DECLARED.has(ev.kind)) tr.lastDeclaredAt = now
      if (ev.kind !== 'paused') {
        tr.pausedSince = undefined
        tr.pausedLastSurfaceAt = undefined
      }
      if (ev.playerRelevant) {
        tr.pendingSignal.push(ev)
        tr.signalSince = tr.signalSince ?? now
      }
    }
    if (tr.pendingSignal.length && tr.signalSince !== undefined && now - tr.signalSince >= grace) {
      const evs = tr.pendingSignal
      tr.pendingSignal = []
      tr.signalSince = undefined
      const kinds = [...new Set(evs.map((e) => e.kind))].join(', ')
      enqueue(
        'signal',
        `${label(t)} reported ${kinds}`,
        t.id,
        evs.map((e) => e.raw),
        false
      )
    }
  }

  // ------------------------------------------------------------ (2) turn end

  function stepTurnEnd(t: Task, tr: Track, now: number): void {
    const m = turnEndMtime(t.id)
    if (m > tr.turnEndSeenMtime) {
      tr.turnEndSeenMtime = m
      tr.turnEndAt = m
      tr.turnEndCheckAt = now + TURN_END_SETTLE_MS
    }
    if (tr.turnEndCheckAt === undefined || now < tr.turnEndCheckAt) return
    const at = tr.turnEndAt ?? now
    tr.turnEndCheckAt = undefined
    const cur = hc().crew.get(t.id) ?? t
    if (!LIVE_FOR_STALE.has(cur.state)) return
    if (tr.lastDeclaredAt >= at - 2_000) return
    if (tr.pendingSignal.length) return
    // quiet for the settle window → the unit stopped without declaring anything
    if (lastOutput(cur, tr) > now - (TURN_END_SETTLE_MS - 5_000)) return
    enqueue('signal', `${label(cur)}: turn ended without a declared status`, cur.id, tailLines(cur, 15), false)
  }

  // ------------------------------------------------------------ (3) stale / exited

  function stepLiveness(t: Task, tr: Track, now: number, s: ReturnType<typeof settings>): void {
    if (!t.terminalId) return
    let info
    try {
      info = ctx().terminals.get(t.terminalId)
    } catch {
      info = undefined
    }
    if (!info || !info.alive) {
      if (EXIT_WATCH.has(t.state) && !tr.exitedReported) {
        tr.exitedReported = true
        const code = info?.exitCode
        hc().crew.update(t.id, { state: 'exited', stateReason: `process ended${code !== undefined ? ` (exit ${code})` : ''} without a final status` })
        hc().crew.bump(t.id, 'stopped')
        enqueue('stale', `${label(t)}: unit process ended${code !== undefined ? ` (exit ${code})` : ''} without a final status`, t.id, tailLines(t, 15), false)
      }
      return
    }
    tr.exitedReported = false
    if (!LIVE_FOR_STALE.has(t.state)) {
      tr.staleEscalations = 0
      return
    }
    const windowMs = Math.max(30, s.staleSeconds || 240) * 1000
    const idle = now - lastOutput(t, tr)
    if (idle < windowMs) {
      tr.staleEscalations = 0
      tr.lastStaleWakeAt = undefined
      return
    }
    if (tr.lastStaleWakeAt && now - tr.lastStaleWakeAt < windowMs) return
    tr.lastStaleWakeAt = now
    tr.staleEscalations++
    // one lagging episode per quiet spell, for the dispatch scorecard
    if (tr.staleEscalations === 1) hc().crew.bump(t.id, 'lagging')
    const deep = tr.staleEscalations > Math.max(1, s.staleEscalations || 3) ? ' demand-deep-inspection' : ''
    enqueue(
      'stale',
      `${label(t)} lagging: escalation ${tr.staleEscalations} — no output for ${Math.round(idle / 1000)}s${deep}`,
      t.id,
      tailLines(t, 12),
      tr.staleEscalations === 1
    )
  }

  // ------------------------------------------------------------ (4) paused

  function stepPaused(t: Task, tr: Track, now: number, s: ReturnType<typeof settings>): void {
    if (t.state !== 'paused') {
      tr.pausedSince = undefined
      tr.pausedLastSurfaceAt = undefined
      return
    }
    if (tr.pausedSince === undefined) {
      tr.pausedSince = now
      tr.pausedLastSurfaceAt = now
    }
    let until: string | undefined
    let note = ''
    try {
      const evs = hc().crew.statusEvents(t.id)
      for (let i = evs.length - 1; i >= 0; i--) {
        if (evs[i].kind === 'paused') {
          until = evs[i].fields.until
          note = evs[i].text
          break
        }
      }
    } catch {
      /* no history */
    }
    if (until && Date.parse(until) <= now && tr.pausedUntilFired !== until) {
      tr.pausedUntilFired = until
      tr.pausedLastSurfaceAt = now
      enqueue('check', `${label(t)}: declared wait expired (until ${until})`, t.id, note ? [note] : [], true)
      return
    }
    const every = Math.max(0.25, s.pausedResurfaceHours || 4) * 3_600_000
    if (now - (tr.pausedLastSurfaceAt ?? now) >= every) {
      tr.pausedLastSurfaceAt = now
      const hrs = Math.round((now - (tr.pausedSince ?? now)) / 3_600_000)
      enqueue('check', `${label(t)}: still paused after ~${hrs}h`, t.id, note ? [note] : [], true)
    }
  }

  // ------------------------------------------------------------ (5) ping inbox

  function stepInbox(t: Task, tr: Track, now: number, s: ReturnType<typeof settings>): void {
    const unread = hc().crew.unreadInbox(t.id)
    if (!unread.length) {
      tr.inboxSeq = undefined
      tr.inboxRings = 0
      tr.inboxEscalated = false
      return
    }
    const oldest = unread[0]
    if (tr.inboxSeq !== oldest.seq) {
      tr.inboxSeq = oldest.seq
      tr.inboxRings = 0
      tr.inboxEscalated = false
      tr.inboxLastRingAt = now - oldest.ageSec * 1000 // the send already rang once
    }
    const graceMs = Math.max(15, s.inboxGraceSeconds || 90) * 1000
    if (oldest.ageSec * 1000 < graceMs) return
    if (tr.inboxLastRingAt !== undefined && now - tr.inboxLastRingAt < graceMs) return
    if (tr.inboxRings < Math.max(1, s.inboxRingMax || 3)) {
      tr.inboxRings++
      tr.inboxLastRingAt = now
      void hc()
        .crew.ring(t.id)
        .catch(() => false)
      return
    }
    if (!tr.inboxEscalated) {
      tr.inboxEscalated = true
      enqueue(
        'stale',
        `${label(t)}: unread ping #${oldest.seq} (rang ${tr.inboxRings} time(s), ${Math.round(oldest.ageSec)}s old)`,
        t.id,
        tailLines(t, 10),
        false
      )
    }
  }

  // ------------------------------------------------------------ (6) PR poll

  function stepPr(t: Task, tr: Track, now: number, s: ReturnType<typeof settings>): void {
    if (!t.pr?.url || t.state !== 'ready' || tr.prBusy) return
    const every = Math.max(1, s.prPollMinutes || 3) * 60_000
    if (tr.prPolledAt && now - tr.prPolledAt < every) return
    let forge
    try {
      forge = ctx().forge
      if (!forge.available()) return
    } catch {
      return
    }
    tr.prPolledAt = now
    tr.prBusy = true
    const url = t.pr.url
    void (async () => {
      try {
        const v = await forge.view(url, t.worktree)
        if (!v.ok) return
        const cur = hc().crew.get(t.id)
        if (!cur || cur.state !== 'ready') return
        const pr = {
          ...cur.pr,
          url,
          state: v.state,
          checks: v.checks,
          mergeable: v.mergeable,
          reviewDecision: v.reviewDecision,
          checkedAt: new Date().toISOString()
        }
        hc().crew.update(t.id, { pr })
        const prevChecks = tr.prChecks
        const prevState = tr.prState
        tr.prChecks = v.checks
        tr.prState = v.state

        if (v.state === 'MERGED' && prevState !== 'MERGED') {
          await onMerged(cur, url)
        } else if (v.state === 'CLOSED' && prevState !== 'CLOSED') {
          enqueue('check', `${label(cur)}: PR closed without merging`, cur.id, [url], false)
        } else if (v.state === 'OPEN') {
          if (v.checks === 'failing' && prevChecks !== 'failing') {
            enqueue('check', `${label(cur)}: PR checks failing`, cur.id, [url, ...v.failing.map((f) => `failing: ${f}`)], false)
          } else if (v.checks === 'passing' && prevChecks !== 'passing') {
            const auto = cur.yolo ? ' (Auto-loot is on for this world)' : ''
            enqueue('check', `${label(cur)}: checks green${auto}`, cur.id, [url], false)
          }
        }
        deliver()
      } catch {
        /* next poll retries */
      } finally {
        tr.prBusy = false
      }
    })()
  }

  async function onMerged(t: Task, url: string): Promise<void> {
    const c = ctx()
    hc().crew.update(t.id, { state: 'merged', landedAt: new Date().toISOString(), stateReason: 'PR merged' })
    let syncMsg = ''
    try {
      const r = await c.projects.sync(t.project)
      syncMsg = r.message
    } catch (e) {
      syncMsg = `sync failed: ${(e as Error).message}`
    }
    try {
      c.ledger.record({ home: home.name, event: 'task.merged', task: t.id, project: t.project, data: { via: 'pr', pr: url } })
      c.stats.award('merge', t.id)
      c.notifier.sfx('merge')
    } catch {
      /* optional */
    }
    let cleanMsg = ''
    try {
      const r = await hc().crew.cleanup(t.id, false)
      cleanMsg = r.ok ? `despawned: ${r.message}` : `despawn refused: ${r.message}`
    } catch (e) {
      cleanMsg = `despawn failed: ${(e as Error).message}`
    }
    enqueue('check', `${label(t)}: PR merged`, t.id, [url, `world sync: ${syncMsg}`, cleanMsg], false)
  }

  // ------------------------------------------------------------ (7) triggers

  function stepTriggers(now: number, s: ReturnType<typeof settings>): void {
    if (!home.isMain) return
    for (const src of s.eventSources ?? []) {
      if (!src.enabled || !src.command?.trim() || triggerBusy.has(src.id)) continue
      const last = src.lastRunAt ? Date.parse(src.lastRunAt) || 0 : 0
      if (now - last < Math.max(15, src.intervalSec || 300) * 1000) continue
      triggerBusy.add(src.id)
      void runTrigger(src).finally(() => triggerBusy.delete(src.id))
    }
  }

  async function runTrigger(src: EventSource): Promise<void> {
    try {
      const r = await runShell(src.command, { cwd: src.cwd || undefined, timeoutMs: 30_000 })
      const output = (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim().slice(0, 4000)
      const prevOut = src.lastOutput
      const prevCode = triggerLastCode.get(src.id)
      triggerLastCode.set(src.id, r.code)
      let fire = false
      let why = ''
      if (src.trigger === 'nonzero') {
        fire = r.code !== 0 && (prevCode === undefined || prevCode === 0)
        why = `exited ${r.code}`
      } else if (src.trigger === 'change') {
        fire = prevOut !== undefined && prevOut !== output
        why = 'output changed'
      } else if (src.trigger === 'match' && src.pattern) {
        let re: RegExp | undefined
        try {
          re = new RegExp(src.pattern, 'm')
        } catch {
          re = undefined
        }
        const hit = re ? re.test(output) : output.includes(src.pattern)
        const prevHit = prevOut !== undefined && (re ? re.test(prevOut) : prevOut.includes(src.pattern))
        fire = hit && (!prevHit || prevOut !== output)
        why = `matched /${src.pattern}/`
      }
      // persist run bookkeeping on the source
      try {
        const st = ctx().settings.get()
        const sources = (st.eventSources ?? []).map((e) =>
          e.id === src.id ? { ...e, lastOutput: output, lastRunAt: new Date().toISOString() } : e
        )
        ctx().settings.save({ eventSources: sources })
      } catch {
        /* settings unavailable */
      }
      if (fire) {
        enqueue('check', `trigger "${src.name}": ${why}`, undefined, output.split(/\r?\n/).slice(-15), false)
        deliver()
      }
    } catch {
      /* trigger failure is not an app failure */
    }
  }

  // ------------------------------------------------------------ (8) tick

  function stepTick(now: number, s: ReturnType<typeof settings>): void {
    const baseMs = Math.max(1, s.heartbeatBaseMinutes || 10) * 60_000
    const maxMs = Math.max(baseMs, (s.heartbeatMaxMinutes || 120) * 60_000)
    if (!nextTickAt) nextTickAt = now + baseMs
    if (now < nextTickAt) return

    const lines: string[] = []
    let surfaced = false

    // deferred choices whose time has come
    try {
      const dec = hc().decisions
      for (const d of dec.list(true)) {
        if (d.resolvedAt || !d.until || Date.parse(d.until) > now) continue
        dec.defer(d.id, '')
        lines.push(`choice ${d.id} resurfaced (deferred until ${d.until}): ${d.question}`)
        surfaced = true
      }
    } catch {
      /* no decisions */
    }

    // quests ready to deploy
    let dispatchable: { id: string; title: string; project?: string; kind: string }[] = []
    try {
      dispatchable = hc().backlog.dispatchable()
    } catch {
      dispatchable = []
    }
    const dispatchSig = dispatchable.map((q) => q.id).sort().join(',')
    if (dispatchable.length && s.autoDispatchQueued && dispatchSig !== lastDispatchSig) {
      for (const q of dispatchable) lines.push(`quest ${q.id} ready to deploy: ${q.kind} "${q.title}"${q.project ? ` (${q.project})` : ''}`)
      surfaced = true
    }
    if (!dispatchable.length) lastDispatchSig = ''
    else if (s.autoDispatchQueued) lastDispatchSig = dispatchSig

    // fleet signature for streak doubling
    let sig = ''
    try {
      sig = hc()
        .crew.list()
        .map((t) => `${t.id}:${t.state}:${t.pr?.state ?? ''}:${t.pr?.checks ?? ''}`)
        .join('|')
      sig += '#' + hc().backlog.list().map((q) => `${q.id}:${q.state}`).join('|')
    } catch {
      /* ignore */
    }
    const changed = sig !== lastFleetSig
    lastFleetSig = sig

    if (surfaced) {
      enqueue('heartbeat', `tick: ${lines.length} item(s) need attention`, undefined, lines, false)
      tickStreak = 0
    } else if (changed) {
      tickStreak = 0
    } else {
      tickStreak++
    }
    nextTickAt = now + Math.min(maxMs, baseMs * Math.pow(2, tickStreak))
  }

  // ------------------------------------------------------------ pass

  async function pass(): Promise<void> {
    if (running) return
    running = true
    try {
      let s: ReturnType<typeof settings>
      try {
        s = settings()
      } catch {
        return
      }
      const now = Date.now()
      const grace = Math.max(0, s.signalGraceSeconds ?? 30) * 1000
      let tasks: Task[] = []
      try {
        tasks = hc().crew.list().filter((t) => t.state !== 'cleaned')
      } catch {
        tasks = []
      }
      const ids = new Set(tasks.map((t) => t.id))
      for (const id of [...tracks.keys()]) if (!ids.has(id)) tracks.delete(id)

      for (const t0 of tasks) {
        const tr = track(t0)
        step('status', () => stepStatus(hc().crew.get(t0.id) ?? t0, tr, now, grace))
        const t = (() => {
          try {
            return hc().crew.get(t0.id) ?? t0
          } catch {
            return t0
          }
        })()
        step('turn-end', () => stepTurnEnd(t, tr, now))
        step('liveness', () => stepLiveness(t, tr, now, s))
        step('paused', () => stepPaused(t, tr, now, s))
        step('inbox', () => stepInbox(t, tr, now, s))
        step('pr', () => stepPr(t, tr, now, s))
      }
      step('triggers', () => stepTriggers(now, s))
      step('tick', () => stepTick(now, s))
    } finally {
      running = false
      deliver()
    }
  }

  function schedule(): void {
    if (timer) clearInterval(timer)
    let secs = 15
    try {
      secs = Math.max(2, settings().pollSeconds || 15)
    } catch {
      secs = 15
    }
    pollMs = secs * 1000
    timer = setInterval(() => void pass(), pollMs)
    timer.unref?.()
  }

  const svc: SupervisorService = {
    start() {
      if (timer) return
      schedule()
      kick = setTimeout(() => void pass(), 2_000)
      kick.unref?.()
      unsub = bus.onEvent((ev) => {
        if (ev.type !== 'settings' || !timer) return
        const next = Math.max(2, ev.settings.pollSeconds || 15) * 1000
        if (next !== pollMs) schedule()
      })
    },

    stop() {
      if (timer) clearInterval(timer)
      if (kick) clearTimeout(kick)
      timer = undefined
      kick = undefined
      unsub?.()
      unsub = undefined
    },

    poke() {
      void pass()
    },

    touch(taskId) {
      try {
        const t = hc().crew.get(taskId)
        if (!t) return
        const tr = track(t)
        tr.touchedAt = Date.now()
        tr.staleEscalations = 0
        tr.lastStaleWakeAt = undefined
      } catch {
        /* unknown task */
      }
    },

    turnEnded(taskId) {
      try {
        const t = hc().crew.get(taskId)
        if (!t) return
        const tr = track(t)
        const now = Date.now()
        tr.turnEndAt = now
        tr.turnEndSeenMtime = Math.max(tr.turnEndSeenMtime, turnEndMtime(taskId))
        tr.turnEndCheckAt = now + TURN_END_SETTLE_MS
      } catch {
        /* unknown task */
      }
    }
  }

  return svc
}
