import { useRef, useSyncExternalStore } from 'react'
import type {
  Achievement, Ally, ChatMessage, FleetSnapshot, GenioEvent, PermissionRequest, Settings, StatusEvent,
  TerminalInfo
} from '@shared/types'
import type { SpawnRequest } from '@shared/api'
import { applyChatEvent, patchAllyControls, type AllyControlsPatch } from '@shared/chat'
import { pendingDecision } from '@shared/decisions'
import { occupiedUnits } from '@shared/unit-capacity'
import { squadSections, squadState } from '@shared/squad-display'
import { playSfx } from './lib/sfx'
import { speak } from './lib/voice'
import { viewAvailable, type ViewId } from './lib/railmenu'
import { supportsUnitySlots } from '@shared/play'
import { effectiveEngine } from '@shared/engine'

export type { ViewId }

const windowParams = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
export const PROJECT_WINDOW = windowParams.get('project') || undefined
export const PROJECT_WKSP = PROJECT_WINDOW ? windowParams.get('wksp') || undefined : undefined
const DEFAULT_VIEW: ViewId = PROJECT_WINDOW ? 'comms' : 'worlds'

export interface Toast {
  id: number
  level: 'info' | 'success' | 'warn' | 'error'
  title: string
  body?: string
}

export type Focus = { type: 'task'; id: string } | { type: 'terminal'; id: string } | null

export interface State {
  registeredProject?: string
  booted: boolean
  connected: boolean
  snap: FleetSnapshot
  settings: Settings | null
  chats: Record<string, ChatMessage[]>
  chatLoaded: Record<string, boolean>
  /** Generations in flight per chat, from generation events (seeded once from cards when the chat loads). */
  generating: Record<string, string[]>
  statusByTask: Record<string, StatusEvent[]>
  terminals: Record<string, TerminalInfo>
  toasts: Toast[]
  permissions: PermissionRequest[]
  achievements: Achievement[]
  /** The floating answer cards are showing (the title bar badge toggles them). */
  answersOpen: boolean
  answerHistory?: 'answered' | 'deferred'
  answerTarget?: string
  /** Bumped by Answer next: the cards take keyboard focus only on this request. */
  answerFocus?: number
  view: ViewId
  focus: Focus
  deploy: Partial<SpawnRequest> | null
  palette: boolean
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
    achievements: [],
    playstyle: { current: 'adventurer', shown: 'adventurer', why: '', samples: 0, counts: { builder: 0, scout: 0, artificer: 0, warden: 0 }, earned: [] },
    landings: [],
    pins: []
  }
}

let state: State = {
  booted: false,
  connected: false,
  snap: emptySnap,
  settings: null,
  chats: {},
  chatLoaded: {},
  generating: {},
  statusByTask: {},
  terminals: {},
  toasts: [],
  permissions: [],
  achievements: [],
  view: DEFAULT_VIEW,
  registeredProject: windowParams.has('registered') ? PROJECT_WINDOW : undefined,
  focus: null,
  deploy: null,
  palette: false,
  answersOpen: true
}

const listeners = new Set<() => void>()

export function getState(): State {
  return state
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...p }
  // Every way into a screen (shortcut, palette, notification, an engine change) lands here:
  // a screen this window does not offer falls back to the default one, quietly.
  if (!viewAvailable(state.view, !!PROJECT_WINDOW, playAvailable(state))) state = { ...state, view: DEFAULT_VIEW }
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

const registeredViews = new Set<string>()
export function registerViews(views: string[]): void { views.forEach((view) => registeredViews.add(view)) }
export function hasView(view: string): boolean { return registeredViews.has(view) }

/** Project screens (Comms, Inventory, Play) always show this window's project; the Hub has none. */
export function go(view: ViewId): void {
  if (view === 'worlds') view = 'systems'
  if (!PROJECT_WINDOW && ['comms', 'inventory', 'play'].includes(view)) view = 'worlds'
  setState({ view, palette: false })
}

export function focusTask(id: string): void {
  setState({ view: 'squad', focus: { type: 'task', id }, palette: false })
}

/** Project chat is always owned by its window. Hub links open that project. */
export function openChat(wksp: string): void {
  if (PROJECT_WKSP) { go('comms'); void loadChat(PROJECT_WKSP); return }
  const world = wksp === 'main' ? 'genio' : state.snap.allies.find(a => a.name === wksp)?.projects[0]
  const project = state.snap.projects.find(p => p.name === world)
  if (project) void op('Open project', () => api().projectOpen(project.path))
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
  if (PROJECT_WINDOW) prefill = { ...prefill, project: PROJECT_WINDOW, wksp: PROJECT_WKSP }
  if (state.snap.projects.find(p => p.name === prefill.project)?.gitRepo === false) {
    toast('info', 'Deploy needs a git repo', 'You can ask Genio to create it in chat.')
    return
  }
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
  if (PROJECT_WKSP && wksp !== PROJECT_WKSP) return
  if (state.chatLoaded[wksp] && !force) return
  try {
    const hist = await api().chatHistory(wksp, 300)
    const running = hist.filter(m => m.generation?.status === 'running' || m.generation?.status === 'placing').map(m => m.id)
    setState((s) => ({
      chats: { ...s.chats, [wksp]: mergeChat(hist, s.chats[wksp] ?? []) },
      chatLoaded: { ...s.chatLoaded, [wksp]: true },
      generating: { ...s.generating, [wksp]: [...new Set([...(s.generating[wksp] ?? []), ...running])] }
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
      setState({ chats: { ...s.chats, [m.wksp]: applyChatEvent(s.chats[m.wksp] ?? [], m) } })
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
    case 'generation': {
      const ids = (s.generating[ev.wksp] ?? []).filter((id) => id !== ev.id)
      setState({ generating: { ...s.generating, [ev.wksp]: ev.active ? [...ids, ev.id] : ids } })
      break
    }
    case 'status': {
      const arr = s.statusByTask[ev.event.taskId] ?? []
      setState({ statusByTask: { ...s.statusByTask, [ev.event.taskId]: [...arr, ev.event].slice(-200) } })
      break
    }
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
    case 'pending-units':
      setState({ snap: { ...s.snap, pendingUnits: ev.projects } })
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
      if (t.view === 'move') {
        const d = s.snap.decisions.find(d => d.id === t.decisionId)
        setState({ answersOpen: true, answerTarget: t.decisionId, answerHistory: d?.resolvedAt ? 'answered' : d?.until && Date.parse(d.until) > Date.now() ? 'deferred' : undefined })
      }
      else if (t.view === 'squad') {
        if (t.taskId) focusTask(t.taskId)
        else go('squad')
      } else if (t.view === 'accounts') {
        go('systems')
        void import('./views/Systems').then((m) => m.requestSystemsSection('accounts'))
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
  window.genio.onTerminalData?.((batch) => {
    const terminals = { ...state.terminals }
    let changed = false
    for (const { id, at } of batch) {
      const terminal = terminals[id]
      const task = state.snap.tasks.find(t => t.terminalId === id && t.state === 'ready')
      const output = terminal && { ...terminal, lastOutputAt: at ?? new Date().toISOString() }
      // Notify the store only when new output actually invalidates a ready
      // label; ordinary terminal streaming stays on its existing fast path.
      if (terminal?.alive && task && output && squadState(task, terminal) === 'READY TO MERGE' && squadState(task, output) === 'WORKING') {
        terminals[id] = output
        changed = true
      }
    }
    if (changed) setState({ terminals })
  })
  try {
    const [snap, settings, terms] = await Promise.all([
      api().snapshot(),
      api().getSettings(),
      api().terminals().catch(() => [] as TerminalInfo[])
    ])
    const terminals: Record<string, TerminalInfo> = {}
    for (const t of terms) terminals[t.id] = t
    setState({
      snap,
      settings,
      terminals,
      connected: true
    })
    if (settings.fx === false) document.body.classList.add('fx-off')
    if (PROJECT_WKSP) await loadChat(PROJECT_WKSP)
  } catch (e) {
    toast('error', 'Could not reach Genio core', errText(e))
  } finally {
    setState({ booted: true })
  }
}

// ------------------------------------------------------------------ selectors

/** Play is offered only in a project window whose project has a supported engine; follows engine changes live. */
export const playAvailable = (s: State): boolean => {
  const project = PROJECT_WINDOW ? s.snap.projects.find((p) => p.name === PROJECT_WINDOW) : undefined
  return !!project && supportsUnitySlots(effectiveEngine(project).engine)
}

export const runningUnits = (s: State): number => occupiedUnits(s.snap.tasks, s.terminals) + (s.snap.pendingUnits?.length ?? 0)

export const LIVE_STATES = new Set(['spawning', 'working', 'paused', 'blocked', 'needs-decision', 'validating', 'ready', 'stale', 'detached', 'exited', 'merged'])

export function liveTasks(s: State): FleetSnapshot['tasks'] {
  return squadRoster(s).active
}

/** Squad list: active units, then the most recent finished ones (newest first, capped). Memoised per snapshot. */
type SquadRoster = Record<'active' | 'done', FleetSnapshot['tasks']>
let rosterCache: { tasks?: FleetSnapshot['tasks']; terminals?: State['terminals']; v: SquadRoster } = { v: { active: [], done: [] } }
export function squadRoster(s: State): SquadRoster {
  if (rosterCache.tasks !== s.snap.tasks || rosterCache.terminals !== s.terminals) {
    rosterCache = { tasks: s.snap.tasks, terminals: s.terminals, v: squadSections(s.snap.tasks, (t) => (t.terminalId ? s.terminals[t.terminalId] : undefined)) }
  }
  return rosterCache.v
}

export function openDecisions(s: State): FleetSnapshot['decisions'] {
  const now = Date.now()
  return s.snap.decisions.filter(d => pendingDecision(d, now))
}


export function toggleAnswers(): void {
  const pending = openDecisions(state).length > 0
  const visible = state.answersOpen && (pending || !!state.answerHistory)
  setState({
    answersOpen: !visible,
    answerTarget: undefined,
    answerHistory: pending ? undefined : state.snap.decisions.some(d => d.resolvedAt) ? 'answered' : 'deferred'
  })
}

/** Answer next (Ctrl+J): show the cards and move keyboard focus to the first one. */
export function answerNext(): void {
  setState(s => ({ answersOpen: true, answerHistory: undefined, answerTarget: undefined, answerFocus: (s.answerFocus ?? 0) + 1 }))
}
