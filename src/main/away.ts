/**
 * Presence: ONLINE / DND / AFK (companion /quiet and /afk + away daemon +
 * wedge alarm).
 *
 * - DND: routine events are handled off-screen by the Bot; player-relevant
 *   escalations still surface, but desktop pings are batched.
 * - AFK: the Bot plays. Every player-relevant outcome is captured here, pushed
 *   to notifiers as a batched digest, and replayed as a welcome-back brief.
 * - Alarm: an AFK choice or failure that stays unseen longer than
 *   `alarmMinutes` fires the configured alarm (rate limited to once / 30 min).
 */
import { spawn } from 'node:child_process'
import type { AwayEntry, AwayMode, AwayState, NotifyTarget } from '@shared/types'
import { bus } from './bus'
import { formatNotification } from './notify-format'
import type { AppCtx, AwayService } from './services'
import { killTree, nowIso, readJson, truncate, writeJson } from './util'

interface AwayFile extends AwayState {
  lastAlarmAt?: string
}

const MAX_HELD = 200
const ALARM_COOLDOWN_MS = 30 * 60_000
const SEVERITY_TAG: Record<AwayEntry['severity'], string> = {
  info: 'INFO',
  decision: 'YOUR MOVE',
  failure: 'FAIL',
  ready: 'LOOT'
}
const SEVERITY_RANK: Record<AwayEntry['severity'], number> = { info: 0, ready: 1, decision: 2, failure: 3 }

export function createAwayService(getCtx: () => AppCtx): AwayService {
  let st: AwayFile | undefined
  let digest: AwayEntry[] = []
  let digestTimer: NodeJS.Timeout | undefined
  let alarmTimer: NodeJS.Timeout | undefined

  const file = (): string => getCtx().main.home.awayFile

  function load(): AwayFile {
    if (!st) {
      let raw: Partial<AwayFile> = {}
      try {
        raw = readJson<Partial<AwayFile>>(file(), {})
      } catch {
        raw = {}
      }
      const mode: AwayMode = raw.mode === 'dnd' || raw.mode === 'afk' ? raw.mode : 'online'
      st = {
        mode,
        since: raw.since,
        held: Array.isArray(raw.held) ? raw.held : [],
        returnSummaryPending: Boolean(raw.returnSummaryPending),
        lastAlarmAt: raw.lastAlarmAt
      }
      if (mode === 'afk') ensureAlarmTimer()
    }
    return st
  }

  function persist(): void {
    try {
      writeJson(file(), st)
    } catch {
      /* in memory still */
    }
    bus.publish({ type: 'away', away: publicState() })
  }

  function publicState(): AwayState {
    const s = load()
    return { mode: s.mode, since: s.since, held: s.held.slice(), returnSummaryPending: s.returnSummaryPending }
  }

  function gamertag(): string {
    try {
      return getCtx().settings.get().gamertag || 'Player'
    } catch {
      return 'Player'
    }
  }

  // ---------------------------------------------------------------- digest

  function scheduleDigest(): void {
    if (digestTimer) return
    let secs = 90
    try {
      secs = Math.max(5, getCtx().settings.get().awayBatchSeconds || 90)
    } catch {
      /* default */
    }
    digestTimer = setTimeout(flushDigest, secs * 1000)
    digestTimer.unref?.()
  }

  function flushDigest(): void {
    digestTimer = undefined
    const batch = digest
    digest = []
    if (!batch.length) return
    const worst = batch.reduce((w, e) => (SEVERITY_RANK[e.severity] > SEVERITY_RANK[w] ? e.severity : w), 'info' as AwayEntry['severity'])
    const top = batch.find((e) => e.severity === worst) ?? batch[0]
    try {
      if (batch.length === 1) notifyEntry(top)
      else {
        const { title, body } = formatNotification({ kind: 'digest', count: batch.length, text: top.text })
        getCtx().notifier.notify(title, body, worst, { target: worst === 'decision' ? { view: 'move' } : entryTarget(top) })
      }
      if (worst === 'decision' || worst === 'failure') getCtx().notifier.sfx('alert')
    } catch {
      /* not wired */
    }
  }

  function notifyEntry(e: AwayEntry): void {
    const { title, body } = formatNotification({ kind: e.severity, text: e.text, where: e.where ?? e.wksp })
    getCtx().notifier.notify(title, body, e.severity, { target: entryTarget(e) })
  }

  // ---------------------------------------------------------------- alarm

  function ensureAlarmTimer(): void {
    if (alarmTimer) return
    alarmTimer = setInterval(checkAlarm, 60_000)
    alarmTimer.unref?.()
  }

  function stopAlarmTimer(): void {
    if (alarmTimer) clearInterval(alarmTimer)
    alarmTimer = undefined
  }

  function checkAlarm(): void {
    try {
      const s = load()
      if (s.mode !== 'afk') return
      const settings = getCtx().settings.get()
      const channel = (settings.alarm || 'auto').trim()
      if (channel === 'off') return
      const limitMs = Math.max(1, settings.alarmMinutes || 15) * 60_000
      const stuck = s.held.filter(
        (e) => !e.delivered && (e.severity === 'decision' || e.severity === 'failure') && Date.now() - Date.parse(e.ts) >= limitMs
      )
      if (!stuck.length) return
      if (s.lastAlarmAt && Date.now() - Date.parse(s.lastAlarmAt) < ALARM_COOLDOWN_MS) return
      s.lastAlarmAt = nowIso()
      persist()
      const summary = `Genio alarm: ${stuck.length} item(s) waiting on you for over ${Math.round(limitMs / 60_000)} min. ${stuck
        .map((e) => `[${SEVERITY_TAG[e.severity]}] ${truncate(e.text, 120)}`)
        .join(' | ')}`
      fireAlarm(channel, summary, stuck)
    } catch {
      /* alarm must never crash overwatch */
    }
  }

  function fireAlarm(channel: string, summary: string, stuck: AwayEntry[]): void {
    const ctx = getCtx()
    if (channel.startsWith('command:')) {
      runAlarmCommand(channel.slice('command:'.length).trim(), summary)
      return
    }
    // auto / default: desktop notification (forced) + alert sound + webhook
    const { title, body } = formatNotification({ kind: 'alarm', count: stuck.length, text: stuck[0]?.text })
    const target: NotifyTarget = stuck.some((e) => e.severity === 'decision') ? { view: 'move' } : entryTarget(stuck[0])
    try {
      ctx.notifier.sfx('alert')
      ctx.notifier.notify(title, body, 'failure', { target, force: true })
    } catch {
      /* best effort */
    }
    bus.toast('error', 'ALARM', summary)
  }

  function runAlarmCommand(cmd: string, summary: string): void {
    if (!cmd) return
    try {
      const quoted = `"${summary.replace(/["\r\n%]/g, ' ')}"`
      const child = spawn(`${cmd} ${quoted}`, {
        shell: true,
        windowsHide: true,
        env: { ...process.env, GENIO_ALARM_SUMMARY: summary }
      })
      const t = setTimeout(() => killTree(child.pid), 10_000)
      child.on('close', () => clearTimeout(t))
      child.on('error', () => clearTimeout(t))
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(summary + '\n')
    } catch {
      /* command channel failed; nothing else to do */
    }
  }

  // ---------------------------------------------------------------- service

  const svc: AwayService = {
    state() {
      return publicState()
    },

    async set(mode) {
      const s = load()
      const prev = s.mode
      if (mode !== 'online' && mode !== 'dnd' && mode !== 'afk') mode = 'online'
      if (prev === mode) return publicState()
      s.mode = mode
      s.since = mode === 'online' ? undefined : nowIso()
      if (mode === 'afk') ensureAlarmTimer()
      else stopAlarmTimer()

      let brief = ''
      if (prev !== 'online' && mode !== prev && (prev === 'afk' || mode === 'online')) {
        brief = svc.takeReturnBrief()
        if (!brief && prev === 'afk') brief = `Welcome back, ${gamertag()}. All clear while you were away.`
        s.returnSummaryPending = false
      }
      persist()

      const ctx = getCtx()
      try {
        ctx.ledger.record({ event: 'presence.changed', data: { from: prev, to: mode } })
        ctx.notifier.sfx('blip')
      } catch {
        /* optional */
      }
      const label = mode === 'online' ? 'ONLINE' : mode === 'dnd' ? 'DO NOT DISTURB' : 'AFK'
      bus.toast('info', `Presence: ${label}`, mode === 'afk' ? 'The Bot has the controls.' : mode === 'dnd' ? 'Routine events stay off-screen.' : undefined)
      if (brief) {
        try {
          ctx.main.wksp.say(brief, 'system')
        } catch {
          /* wksp not ready */
        }
        bus.toast('success', 'Welcome back', truncate(brief, 300))
      }
      // Events that were routed to the Bot may now belong on Comms.
      try {
        for (const h of ctx.homes.values()) h.wksp.deliverWakes()
      } catch {
        /* not wired */
      }
      return publicState()
    },

    capture(entry) {
      const s = load()
      const full: AwayEntry = { ...entry, text: entry.text.trim(), ts: nowIso(), delivered: false }
      if (s.mode === 'online') {
        // Not away: deliver straight away.
        full.delivered = true
        s.held.push(full)
        if (s.held.length > MAX_HELD) s.held = s.held.slice(-MAX_HELD)
        persist()
        try {
          notifyEntry(full)
        } catch {
          /* not wired */
        }
        return
      }
      s.held.push(full)
      if (s.held.length > MAX_HELD) s.held = s.held.slice(-MAX_HELD)
      s.returnSummaryPending = true
      persist()
      digest.push(full)
      scheduleDigest()
      if (s.mode === 'afk') ensureAlarmTimer()
    },

    takeReturnBrief() {
      const s = load()
      const pending = s.held.filter((e) => !e.delivered)
      if (!pending.length) return ''
      for (const e of pending) e.delivered = true
      s.returnSummaryPending = false
      persist()
      const order = pending.slice().sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.ts.localeCompare(b.ts))
      const where = s.since ? ` (since ${new Date(s.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : ''
      const lines = [`Welcome back, ${gamertag()}. ${pending.length} update(s) while you were away${where}:`]
      for (const e of order) {
        const wksp = e.wksp && e.wksp !== 'main' ? ` [${e.wksp}]` : ''
        lines.push(`- [${SEVERITY_TAG[e.severity]}]${wksp} ${e.text}`)
      }
      const moves = pending.filter((e) => e.severity === 'decision').length
      if (moves) lines.push(`${moves} choice(s) still need your move — open YOUR MOVE.`)
      return lines.join('\n')
    }
  }

  return svc
}

function entryTarget(e: AwayEntry | undefined): NotifyTarget {
  if (e?.target) return e.target
  if (e?.severity === 'decision') return { view: 'move' }
  return { view: 'comms', wksp: e?.wksp }
}
