/**
 * Bus → windows. One place decides what each window receives:
 *
 *   - the fleet snapshot an event needs for routing is computed lazily, at most
 *     once per event (or per terminal flush), and only when a window needs it;
 *   - chat deltas are coalesced per message and flushed every DELTA_FLUSH_MS,
 *     always ahead of any other event, so the stream stays in order while the
 *     renderer gets at most ~25 updates per second;
 *   - terminal output is batched every TERMINAL_FLUSH_MS per window;
 *   - the Hub (no binding) observes the fleet but never receives chat or
 *     terminal traffic it has no screen for.
 */
import { EVENT_CHANNEL } from '@shared/api'
import type { FleetSnapshot, GenioEvent, TerminalInfo } from '@shared/types'
import { routeProjectEvent, terminalProject, type WindowBinding } from './project-windows'

export const TERM_CHANNEL = 'genio:term-data'
export const DELTA_FLUSH_MS = 40
export const TERMINAL_FLUSH_MS = 16

export interface RoutedWindow {
  binding?: WindowBinding
  /** false once the window or its web contents is gone */
  alive(): boolean
  send(channel: string, payload: unknown): void
}

export interface EventRouter {
  /** route one bus event (deltas are coalesced; everything else goes out at once, after pending deltas) */
  publish(ev: GenioEvent): void
  /** raw PTY output; batched per TERMINAL_FLUSH_MS and sent only to the owning project window */
  terminalData(id: string, data: string): void
  /** send everything still pending (shutdown, tests) */
  flush(): void
  stop(): void
}

export interface EventRouterOptions {
  snapshot(): FleetSnapshot
  terminal(id: string): TerminalInfo | undefined
  windows(): Iterable<RoutedWindow>
}

export function createEventRouter(opts: EventRouterOptions): EventRouter {
  const terminalOwners = new Map<string, string | undefined>()
  const deltas = new Map<string, Extract<GenioEvent, { type: 'chat-delta' | 'design-chat-delta' }>>()
  let deltaTimer: NodeJS.Timeout | undefined
  let batch: { id: string; data: string; at: string }[] = []
  let terminalTimer: NodeJS.Timeout | undefined

  /** The snapshot for one routing pass: built on first use, shared by every window. */
  const lazySnapshot = (): (() => FleetSnapshot) => {
    let snap: FleetSnapshot | undefined
    return () => (snap ??= opts.snapshot())
  }

  const live = (): RoutedWindow[] => [...opts.windows()].filter((w) => w.alive())

  const route = (ev: GenioEvent): void => {
    const snapshot = lazySnapshot()
    if (ev.type === 'terminal') terminalOwners.set(ev.terminal.id, terminalProject(ev.terminal, snapshot()))
    const owner = ev.type === 'terminal' ? terminalOwners.get(ev.terminal.id) : ev.type === 'terminal-removed' ? terminalOwners.get(ev.id) : undefined
    for (const win of live()) {
      const routed = routeProjectEvent(ev, win.binding, snapshot, owner)
      if (routed) win.send(EVENT_CHANNEL, routed)
    }
  }

  const flushDeltas = (): void => {
    if (deltaTimer) clearTimeout(deltaTimer)
    deltaTimer = undefined
    if (!deltas.size) return
    const pending = [...deltas.values()]
    deltas.clear()
    const windows = live().filter((w) => w.binding)
    for (const ev of pending) {
      for (const win of windows) if (win.binding!.wksp === ev.wksp) win.send(EVENT_CHANNEL, ev)
    }
  }

  const flushTerminals = (): void => {
    if (terminalTimer) clearTimeout(terminalTimer)
    terminalTimer = undefined
    if (!batch.length) return
    // merge consecutive chunks per terminal
    const merged = new Map<string, { data: string; at: string }>()
    for (const b of batch) merged.set(b.id, { data: (merged.get(b.id)?.data ?? '') + b.data, at: b.at })
    batch = []
    const windows = live().filter((w) => w.binding)
    if (!windows.length) return
    const snapshot = lazySnapshot()
    const owners = new Map<string, string | undefined>()
    for (const id of merged.keys()) {
      const t = opts.terminal(id)
      // Ownership resolved once per flush; a removed terminal keeps the owner recorded for its last chunks.
      owners.set(id, t ? terminalProject(t, snapshot()) : terminalOwners.get(id))
    }
    for (const win of windows) {
      const chunks = [...merged.entries()].filter(([id]) => owners.get(id) === win.binding!.project).map(([id, output]) => ({ id, ...output }))
      if (chunks.length) win.send(TERM_CHANNEL, chunks)
    }
  }

  return {
    publish(ev) {
      if (ev.type === 'chat-delta' || ev.type === 'design-chat-delta') {
        const key = `${ev.wksp}\u0000${ev.type === 'design-chat-delta' ? ev.conversation : ''}\u0000${ev.id}`
        const cur = deltas.get(key)
        if (cur) cur.text += ev.text
        else deltas.set(key, { ...ev })
        if (!deltaTimer) {
          deltaTimer = setTimeout(flushDeltas, DELTA_FLUSH_MS)
          deltaTimer.unref?.()
        }
        return
      }
      // Anything else must land after the deltas that preceded it (a final chat message replaces its stream).
      flushDeltas()
      route(ev)
    },
    terminalData(id, data) {
      batch.push({ id, data, at: new Date().toISOString() })
      if (!terminalTimer) {
        terminalTimer = setTimeout(flushTerminals, TERMINAL_FLUSH_MS)
        terminalTimer.unref?.()
      }
    },
    flush() {
      flushDeltas()
      flushTerminals()
    },
    stop() {
      if (deltaTimer) clearTimeout(deltaTimer)
      if (terminalTimer) clearTimeout(terminalTimer)
      deltaTimer = terminalTimer = undefined
      deltas.clear()
      batch = []
    }
  }
}
