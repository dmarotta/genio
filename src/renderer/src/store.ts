import { useRef, useSyncExternalStore } from 'react'
import type {
  Achievement, Ally, ChatMessage, FleetSnapshot, GenioEvent, PermissionRequest, Settings, StatusEvent,
  TerminalInfo, Wake
} from '@shared/types'
import type { SpawnRequest } from '@shared/api'
import { patchAllyControls, type AllyControlsPatch } from '@shared/chat'
import { DOCK_STORAGE_KEY, closePanel, focusPanel, openPanel, parseDock, reconcileDock, serializeDock, spawnWorldAlly, type DockState } from './lib/dock'
import { playSfx } from './lib/sfx'
import { speak } from './lib/voice'

export type ViewId = 'comms' | 'squad' | 'quests' | 'move' | 'status' | 'worlds' | 'lore' | 'systems' | 'fal'

/** Ctrl+N order (the rail may show them in a different order) */
export const VIEWS: ViewId[] = ['comms', 'squad', 'quests', 'move', 'status', 'worlds', 'lore', 'systems', 'fal']

export interface Toast {
  id: number
  level: 'info' | 'success' | 'warn' | 'error'
  title: string
  body?: string
}

export interface FeedItem {
  id: string
  ts: string
  kind: 'event' | 'lag' | 'check' | 'tick' | 'status'
  tone: 'neon' | 'volt' | 'amber' | 'alert' | 'violet' | 'mute'
  taskId?: string
  text: string
}

export type Focus = { type: 'task'; id: string } | { type: 'terminal'; id: string } | null

export interface State {
  booted: boolean
  connected: boolean
  snap: FleetSnapshot
  settings: Settings | null
  chats: Record<string, ChatMessage[]>
  chatLoaded: Record<string, boolean>
  feed: FeedItem[]
  statusByTask: Record<string, StatusEvent[]>
  terminals: Record<string, TerminalInfo>
  toasts: Toast[]
  permissions: PermissionRequest[]
  achievements: Achievement[]
  view: ViewId
  focus: Focus
  /** chat screen dock layout (persisted in localStorage) */
  dock: DockState
  deploy: Partial<SpawnRequest> | null
  palette: boolean
  highlightWorld?: string
  welcomeDismissedAt?: string
}

const emptySnap: FleetSnapshot = {
  tasks: [],
  backlog: [],
  decisions: [],
  projects: [],
  wksps: [],
  allies: [],
  away: { mode: 'online', held: [], returnSummaryPending: false },
  inbox: [],
  stats: {
    shippedToday: 0,
    shippedTotal: 0,
    scoutsTotal: 0,
    costTodayUsd: 0,
    level: 1,
    xp: 0,
    xpNext: 500,
    streakDays: 0,
    achievements: []
  }
}

let state: State = {
  booted: false,
  connected: false,
  snap: emptySnap,
  settings: null,
  chats: {},
  chatLoaded: {},
  feed: [],
  statusByTask: {},
  terminals: {},
  toasts: [],
  permissions: [],
  achievements: [],
  view: 'comms',
  focus: null,
  dock: loadDock(),
  deploy: null,
  palette: false
}

const listeners = new Set<() => void>()

export function getState(): State {
  return state
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...p }
  for (const l of listeners) l()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Select from the store. Results are cached per (state, selector) so derived
 * arrays stay referentially stable between getSnapshot calls.
 */
export function useStore<T>(sel: (s: State) => T): T {
  const cache = useRef<{ s?: State; sel?: (s: State) => T; v?: T }>({})
  const get = (): T => {
    const c = cache.current
    if (c.s !== state || c.sel !== sel) {
      cache.current = { s: state, sel, v: sel(state) }
    }
    return cache.current.v as T
  }
  return useSyncExternalStore(subscribe, get)
}

export const api = (): typeof window.genio.api => window.genio.api

// ------------------------------------------------------------------ helpers

let toastSeq = 0
export function toast(level: Toast['level'], title: string, body?: string): void {
  const id = ++toastSeq
  setState((s) => ({ toasts: [...s.toasts.slice(-4), { id, level, title, body }] }))
  setTimeout(() => dismissToast(id), level === 'error' ? 9000 : 5000)
}

export function dismissToast(id: number): void {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

/** Run an op, toast the result. Returns the op result or undefined on throw. */
export async function op<T>(label: string, fn: () => Promise<T>, okMsg?: (r: T) => string | undefined): Promise<T | undefined> {
  try {
    const r = await fn()
    const maybe = r as unknown as { ok?: boolean; message?: string }
    if (maybe && typeof maybe === 'object' && 'ok' in maybe && typeof maybe.ok === 'boolean') {
      if (maybe.ok) toast('success', label, maybe.message || okMsg?.(r))
      else {
        toast('error', label, maybe.message)
        playSfx('error', state.settings)
      }
    } else {
      const m = okMsg?.(r)
      if (m) toast('success', label, m)
    }
    return r
  } catch (e) {
    toast('error', label, errText(e))
    playSfx('error', state.settings)
    return undefined
  }
}

export function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  // strip electron's "Error invoking remote method 'x': Error: " prefix
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function go(view: ViewId): void {
  setState({ view, palette: false })
}

export function focusTask(id: string): void {
  setState({ view: 'squad', focus: { type: 'task', id }, palette: false })
}

// ------------------------------------------------------------------ chat dock

function loadDock(): DockState {
  try {
    return parseDock(localStorage.getItem(DOCK_STORAGE_KEY))
  } catch {
    return parseDock(null)
  }
}

let dockSaveTimer: number | undefined
export function setDock(fn: (d: DockState) => DockState): void {
  const next = fn(state.dock)
  if (next === state.dock) return
  setState({ dock: next })
  if (dockSaveTimer) window.clearTimeout(dockSaveTimer)
  dockSaveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(DOCK_STORAGE_KEY, serializeDock(state.dock))
    } catch {
      /* storage unavailable: the layout just won't survive a restart */
    }
  }, 300)
}

/** Drop panels of retired or missing allies; open tabs for allies the dock has not met yet. */
function syncDock(): void {
  setDock((d) => reconcileDock(d, state.snap.allies))
}

/** Open (or focus) a chat tab and switch to the chat screen. */
export function openChat(wksp: string): void {
  setDock((d) => openPanel(d, wksp))
  go('comms')
  void loadChat(wksp)
}

/** Hide a chat tab. The ally keeps running; the main chat cannot be closed. */
export function closeChat(wksp: string): void {
  setDock((d) => closePanel(d, wksp))
}

export function focusChat(wksp: string): void {
  setDock((d) => focusPanel(d, wksp))
}

/** World → ally: create the world's ally once, then just reopen its tab. */
export async function spawnWorldAllyChat(world: string): Promise<void> {
  try {
    await spawnWorldAlly(world, {
      allies: () => state.snap.allies,
      create: (req) => api().allyCreate(req),
      open: (ally) => {
        // The 'allies' event may land after the create reply; keep the ally so the dock doesn't drop its tab.
        if (!state.snap.allies.some((x) => x.name === ally.name && !x.retiredAt)) {
          setState((s) => ({ snap: { ...s.snap, allies: [...s.snap.allies.filter((x) => x.name !== ally.name), ally] } }))
        }
        openChat(ally.name)
      }
    })
  } catch (e) {
    toast('error', 'Could not spawn ally', errText(e))
    playSfx('error', state.settings)
  }
}

/**
 * Save one chat's controls (approval mode, model, effort). The main chat writes the Genio
 * settings; an ally saves its own overrides ('' = follow the main chat). Either way they
 * persist across restarts and apply to that chat's session from its next turn.
 */
export async function saveChatControls(wksp: string, patch: AllyControlsPatch): Promise<void> {
  if (wksp === 'main') {
    const p: Partial<Settings> = {}
    if (patch.shellMode) p.chatShellMode = patch.shellMode
    if (patch.model !== undefined) p.wkspModel = patch.model
    if (patch.effort !== undefined) p.wkspEffort = patch.effort
    return saveSettings(p)
  }
  const swap = (a: Ally): void => setState((s) => ({ snap: { ...s.snap, allies: s.snap.allies.map((x) => (x.name === a.name && !x.retiredAt ? a : x)) } }))
  const cur = state.snap.allies.find((a) => a.name === wksp && !a.retiredAt)
  if (cur) swap(patchAllyControls(cur, patch))
  try {
    swap(await api().allyUpdate(wksp, patch))
  } catch (e) {
    if (cur) swap(cur)
    toast('error', 'Ally settings not saved', errText(e))
  }
}

export function openDeploy(prefill: Partial<SpawnRequest> = {}): void {
  setState({ deploy: { kind: 'ship', ...prefill }, palette: false })
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  // optimistic
  setState((s) => ({ settings: s.settings ? { ...s.settings, ...patch } : s.settings }))
  try {
    const next = await api().saveSettings(patch)
    setState({ settings: next })
  } catch (e) {
    toast('error', 'Settings not saved', errText(e))
  }
}

export async function loadChat(wksp: string, force = false): Promise<void> {
  if (state.chatLoaded[wksp] && !force) return
  try {
    const hist = await api().chatHistory(wksp, 300)
    setState((s) => ({
      chats: { ...s.chats, [wksp]: mergeChat(hist, s.chats[wksp] ?? []) },
      chatLoaded: { ...s.chatLoaded, [wksp]: true }
    }))
  } catch {
    /* main not ready yet */
  }
}

function mergeChat(base: ChatMessage[], extra: ChatMessage[]): ChatMessage[] {
  const map = new Map<string, ChatMessage>()
  for (const m of base) map.set(m.id, m)
  for (const m of extra) map.set(m.id, m)
  return [...map.values()].sort((a, b) => a.ts.localeCompare(b.ts))
}

let refreshTimer: number | undefined
function scheduleRefresh(): void {
  if (refreshTimer) window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(async () => {
    try {
      const snap = await api().snapshot()
      setState({ snap })
    } catch {
      /* ignore */
    }
  }, 250)
}

// ------------------------------------------------------------------ feed

function wakeToFeed(w: Wake): FeedItem {
  const map: Record<Wake['kind'], FeedItem['kind']> = { signal: 'event', stale: 'lag', check: 'check', heartbeat: 'tick' }
  const tone: FeedItem['tone'] = w.kind === 'stale' ? 'alert' : w.kind === 'heartbeat' ? 'mute' : w.routine ? 'neon' : 'amber'
  return { id: `w${w.wksp}-${w.seq}`, ts: w.ts, kind: map[w.kind], tone, taskId: w.taskId, text: w.reason }
}

function statusToFeed(e: StatusEvent): FeedItem {
  const tone: FeedItem['tone'] =
    e.kind === 'failed' || e.kind === 'blocked'
      ? 'alert'
      : e.kind === 'needs-decision'
        ? 'amber'
        : e.kind === 'done'
          ? 'volt'
          : e.kind === 'note' || e.kind === 'resolved'
            ? 'mute'
            : 'neon'
  return { id: `s${e.taskId}-${e.ts}-${e.raw.length}`, ts: e.ts, kind: 'status', tone, taskId: e.taskId, text: `${e.kind}${e.key && e.key !== 'default' ? ` [${e.key}]` : ''}: ${e.text}` }
}

function pushFeed(item: FeedItem): void {
  setState((s) => {
    if (s.feed.some((f) => f.id === item.id)) return {}
    return { feed: [item, ...s.feed].slice(0, 80) }
  })
}

// ------------------------------------------------------------------ events

function upsertBy<T>(list: T[], item: T, key: (t: T) => string): T[] {
  const k = key(item)
  const i = list.findIndex((x) => key(x) === k)
  if (i < 0) return [...list, item]
  const copy = list.slice()
  copy[i] = item
  return copy
}

export function handleEvent(ev: GenioEvent): void {
  const s = state
  switch (ev.type) {
    case 'snapshot':
      setState({ snap: ev.data })
      if (s.connected) syncDock()
      break
    case 'task':
      setState({ snap: { ...s.snap, tasks: upsertBy(s.snap.tasks, ev.task, (t) => t.id) } })
      break
    case 'task-removed':
      setState({ snap: { ...s.snap, tasks: s.snap.tasks.filter((t) => t.id !== ev.id) } })
      break
    case 'backlog':
      if (s.snap.allies.some((a) => !a.retiredAt)) scheduleRefresh()
      else setState({ snap: { ...s.snap, backlog: ev.items } })
      break
    case 'decisions':
      if (s.snap.allies.some((a) => !a.retiredAt)) scheduleRefresh()
      else setState({ snap: { ...s.snap, decisions: ev.decisions } })
      break
    case 'projects':
      setState({ snap: { ...s.snap, projects: ev.projects } })
      break
    case 'wksp':
      setState({ snap: { ...s.snap, wksps: upsertBy(s.snap.wksps, ev.wksp, (m) => m.name) } })
      break
    case 'chat': {
      const m = ev.message
      const list = s.chats[m.wksp] ?? []
      setState({ chats: { ...s.chats, [m.wksp]: upsertBy(list, m, (x) => x.id) } })
      break
    }
    case 'chat-delta': {
      const list = s.chats[ev.wksp] ?? []
      const i = list.findIndex((x) => x.id === ev.id)
      let next: ChatMessage[]
      if (i < 0) {
        next = [...list, { id: ev.id, wksp: ev.wksp, role: 'genio', text: ev.text, ts: new Date().toISOString(), partial: true }]
      } else {
        next = list.slice()
        next[i] = { ...next[i], text: next[i].text + ev.text, partial: true }
      }
      setState({ chats: { ...s.chats, [ev.wksp]: next } })
      break
    }
    case 'status': {
      const arr = s.statusByTask[ev.event.taskId] ?? []
      setState({ statusByTask: { ...s.statusByTask, [ev.event.taskId]: [...arr, ev.event].slice(-200) } })
      pushFeed(statusToFeed(ev.event))
      break
    }
    case 'wake':
      pushFeed(wakeToFeed(ev.wake))
      break
    case 'away':
      setState({ snap: { ...s.snap, away: ev.away } })
      break
    case 'inbox':
      setState({ snap: { ...s.snap, inbox: ev.notes } })
      break
    case 'stats':
      setState({ snap: { ...s.snap, stats: ev.stats } })
      break
    case 'achievement':
      setState({ achievements: [...s.achievements, ev.achievement] })
      playSfx('levelup', s.settings)
      break
    case 'toast':
      toast(ev.level, ev.title, ev.body)
      break
    case 'permission':
      setState({ permissions: upsertBy(s.permissions, ev.request, (p) => p.id) })
      playSfx('alert', s.settings)
      break
    case 'permission-resolved':
      setState({ permissions: s.permissions.filter((p) => p.id !== ev.id) })
      break
    case 'terminal':
      setState({ terminals: { ...s.terminals, [ev.terminal.id]: ev.terminal } })
      break
    case 'terminal-removed': {
      const t = { ...s.terminals }
      delete t[ev.id]
      const focus = s.focus?.type === 'terminal' && s.focus.id === ev.id ? null : s.focus
      setState({ terminals: t, focus })
      break
    }
    case 'settings':
      setState({ settings: ev.settings })
      break
    case 'allies':
      setState({ snap: { ...s.snap, allies: ev.allies } })
      if (s.connected) syncDock()
      break
    case 'sfx':
      playSfx(ev.sound, s.settings)
      break
    case 'speak':
      if (s.settings?.voice) speak(ev.text)
      break
    case 'navigate': {
      // a desktop notification was clicked
      const t = ev.target
      if (t.view === 'move') go('move')
      else if (t.view === 'squad') {
        if (t.taskId) focusTask(t.taskId)
        else go('squad')
      } else {
        const known = t.wksp === 'main' || s.snap.allies.some((a) => a.name === t.wksp && !a.retiredAt)
        if (t.wksp && known) openChat(t.wksp)
        else go('comms')
      }
      break
    }
  }
}

// ------------------------------------------------------------------ boot

export async function boot(): Promise<void> {
  if (!window.genio) {
    setState({ booted: true, connected: false })
    return
  }
  window.genio.on(handleEvent)
  try {
    const [snap, settings, terms, wakes] = await Promise.all([
      api().snapshot(),
      api().getSettings(),
      api().terminals().catch(() => [] as TerminalInfo[]),
      api().wakes(40).catch(() => [] as Wake[])
    ])
    const terminals: Record<string, TerminalInfo> = {}
    for (const t of terms) terminals[t.id] = t
    setState({
      snap,
      settings,
      terminals,
      connected: true,
      feed: wakes.map(wakeToFeed).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 80)
    })
    if (settings.fx === false) document.body.classList.add('fx-off')
    syncDock()
    await loadChat('main')
  } catch (e) {
    toast('error', 'Could not reach Genio core', errText(e))
  } finally {
    setState({ booted: true })
  }
}

// ------------------------------------------------------------------ selectors

export const LIVE_STATES = new Set(['spawning', 'working', 'paused', 'blocked', 'needs-decision', 'validating', 'ready', 'stale', 'detached', 'exited', 'merged'])

export function liveTasks(s: State): FleetSnapshot['tasks'] {
  return s.snap.tasks.filter((t) => t.state !== 'cleaned' && !(t.kind === 'scout' && t.state === 'done' && !t.terminalId))
}

export function openDecisions(s: State): FleetSnapshot['decisions'] {
  const now = Date.now()
  return s.snap.decisions.filter((d) => !d.resolvedAt && (!d.until || new Date(d.until).getTime() <= now))
}

export function readyTasks(s: State): FleetSnapshot['tasks'] {
  return s.snap.tasks.filter((t) => t.state === 'ready')
}

export function heldQuests(s: State): FleetSnapshot['backlog'] {
  return s.snap.backlog.filter((b) => b.state === 'held' || (b.hold && b.state !== 'done' && b.state !== 'dropped'))
}
