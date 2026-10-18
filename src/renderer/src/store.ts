import { useRef, useSyncExternalStore } from 'react'
import type {
  Achievement, Ally, ChatMessage, DesignChatInfo, FleetSnapshot, GenioEvent, PermissionRequest, Settings, StatusEvent,
  TerminalInfo
} from '@shared/types'
import type { SpawnRequest } from '@shared/api'
import { applyChatEvent, chatKey, cleanChatMessage, patchAllyControls, type AllyControlsPatch } from '@shared/chat'
import { askingDecision } from '@shared/decisions'
import { occupiedUnits } from '@shared/unit-capacity'
import { squadSections } from '@shared/squad-display'
import { playSfx } from './lib/sfx'
import { speak, stopSpeaking } from './lib/voice'
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

export type DesignOpen = { kind: 'chat'; id: string } | { kind: 'note'; name: string }

export type Focus ={ type: 'task'; id: string } | { type: 'terminal'; id: string } | null

export interface State {
  booted: boolean
  connected: boolean
  snap: FleetSnapshot
  settings: Settings | null
  /** Keyed by chat: the project chat by its wksp, a design chat by chatKey(wksp, id). */
  chats: Record<string, ChatMessage[]>
  chatLoaded: Record<string, boolean>
  /** This project window's design chats; undefined until the Design screen first loads them. */
  designChats?: DesignChatInfo[]
  /** The chat or note the Design screen shows, kept while the player visits other screens. */
  designOpen?: DesignOpen
  /** Generations in flight per chat, from generation events (seeded once from cards when the chat loads). */
  generating: Record<string, string[]>
  statusByTask: Record<string, StatusEvent[]>
  terminals: Record<string, TerminalInfo>
  toasts: Toast[]
  /** One transient, project-scoped tip; history and once-only caps belong to main. */
  tip?: { id: string; line: string; question: string; shownAt: number }
  permissions: PermissionRequest[]
  achievements: Achievement[]
  /** Tools (Claude, Codex) that need a sign-in now: the rail warns while this is not empty. */
  signIn: string[]
  /** The launcher's gate: neither Claude nor Codex is signed in, so no project opens. */
  signInGate: boolean
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
  /** The terminal pane is showing (hidden keeps its shell running; closing it stops the shell). */
  paneOpen: boolean
  /** The pane tab in front: a '!' run's terminal id; unset = the shell */
  paneTab?: string
  /** The pane's folder: 'main' or a unit id (see paneCwds) */
  paneCwd: string
  /** Why the pane's shell could not start (bad folder); shell mode is unavailable meanwhile */
  paneError?: string
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
    landings: [],
    pins: []
  }
}

// Units the player despawned while main still removes them (despawnUnit): left out of snap.tasks, and
// their in-flight quests out of snap.backlog, so every list drops them at once. allTasks and allBacklog
// keep main's own view, to bring a unit back when its removal fails.
const despawning = new Set<string>()
let allTasks = emptySnap.tasks
let allBacklog = emptySnap.backlog

function shown(snap: FleetSnapshot): FleetSnapshot {
  if (!despawning.size) return { ...snap, tasks: allTasks, backlog: allBacklog }
  const quests = new Set(allTasks.filter((t) => despawning.has(t.id) && t.backlogId).map((t) => t.backlogId!))
  return {
    ...snap,
    tasks: allTasks.filter((t) => !despawning.has(t.id)),
    backlog: allBacklog.filter((q) => q.state !== 'in-flight' || !(quests.has(q.id) || (q.taskId && despawning.has(q.taskId))))
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
  signIn: [],
  signInGate: false,
  view: DEFAULT_VIEW,
  focus: null,
  deploy: null,
  palette: false,
  answersOpen: true,
  paneOpen: false,
  paneCwd: 'main'
}

const listeners = new Set<() => void>()

export function getState(): State {
  return state
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch
  const prev = state.snap
  state = { ...state, ...p }
  // A patch that brings tasks or quests brings main's view of them; a despawning unit stays left out
  // until main reports it cleaned (or gone).
  if (p.snap && (p.snap.tasks !== prev.tasks || p.snap.backlog !== prev.backlog)) {
    if (p.snap.tasks !== prev.tasks) allTasks = p.snap.tasks
    if (p.snap.backlog !== prev.backlog) allBacklog = p.snap.backlog
    for (const id of despawning) {
      const t = allTasks.find((x) => x.id === id)
      if (!t || t.state === 'cleaned') despawning.delete(id)
    }
    state = { ...state, snap: shown(state.snap) }
  }
  publish()
}

function publish(): void {
  if (state.tip && (state.settings?.featureTips === false || state.snap.away.mode !== 'online')) state = { ...state, tip: undefined }
  // Every way into a screen (shortcut, palette, notification, an engine change) lands here:
  // a screen this window does not offer falls back to the default one, quietly.
  if (!viewAvailable(state.view, !!PROJECT_WINDOW, playAvailable(state))) state = { ...state, view: DEFAULT_VIEW }
  for (const l of listeners) l()
}

export function subscribe(fn: () => void): () => void {
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

/**
 * Despawn a unit on the player's word (unlanded work goes too): it leaves every list at once while main
 * removes its copy, which can take a while. A refusal or error brings it back where it was, with the
 * reason in a toast. One removal per unit at a time: a second call while one runs does nothing.
 */
export async function despawnUnit(id: string): Promise<void> {
  if (despawning.has(id)) return
  const hide = (on: boolean): void => {
    if (on) despawning.add(id)
    else despawning.delete(id)
    state = { ...state, snap: shown(state.snap) }
    publish()
  }
  hide(true)
  let failed = true
  try {
    const r = await api().cleanupTask(id, true)
    if (r.ok) failed = false
    else toast('error', 'Despawn failed', r.message)
  } catch (e) {
    toast('error', 'Despawn failed', errText(e))
  }
  // On success it stays left out until main's update says cleaned (that update may have come already).
  const cleaned = allTasks.every((t) => t.id !== id || t.state === 'cleaned')
  if (despawning.has(id) && (failed || cleaned)) hide(false)
}

export function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  // strip electron's "Error invoking remote method 'x': Error: " prefix
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

const registeredViews = new Set<string>()
export function registerViews(views: string[]): void { views.forEach((view) => registeredViews.add(view)) }
export function hasView(view: string): boolean { return registeredViews.has(view) }

/** Project screens (Comms, Inventory, Art Bible, Play) always show this window's project; the Hub has none. */
export function go(view: ViewId): void {
  if (view === 'worlds') view = 'systems'
  if (!PROJECT_WINDOW && !viewAvailable(view, false, true)) view = 'worlds'
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

export async function loadChat(wksp: string, force = false, conversation?: string): Promise<void> {
  if (PROJECT_WKSP && wksp !== PROJECT_WKSP) return
  const key = chatKey(wksp, conversation)
  if (state.chatLoaded[key] && !force) return
  try {
    const hist = (await (conversation ? api().chatHistory(wksp, 300, conversation) : api().chatHistory(wksp, 300))).map(cleanChatMessage)
    const running = hist.filter(m => m.generation?.status === 'running' || m.generation?.status === 'placing').map(m => m.id)
    setState((s) => ({
      chats: { ...s.chats, [key]: mergeChat(hist, s.chats[key] ?? []) },
      chatLoaded: { ...s.chatLoaded, [key]: true },
      ...(conversation ? {} : { generating: { ...s.generating, [wksp]: [...new Set([...(s.generating[wksp] ?? []), ...running])] } })
    }))
  } catch {
    /* main not ready yet */
  }
}

/** The project's design chats, for the Design screen; events keep them current afterwards. */
export async function loadDesignChats(): Promise<void> {
  if (!PROJECT_WKSP) return
  try {
    const chats = await api().designChats(PROJECT_WKSP)
    setState({ designChats: chats })
  } catch (e) {
    setState({ designChats: [] })
    toast('error', 'Lore chats unavailable', errText(e))
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

/** A streamed piece of a reply: appended to its message, or the start of a new partial one. */
function withDelta(list: ChatMessage[], wksp: string, id: string, text: string): ChatMessage[] {
  const i = list.findIndex((x) => x.id === id)
  if (i < 0) return [...list, cleanChatMessage({ id, wksp, role: 'genio', text, ts: new Date().toISOString(), partial: true })]
  const next = list.slice()
  next[i] = cleanChatMessage({ ...next[i], text: next[i].text + text, partial: true })
  return next
}

export function handleEvent(ev: GenioEvent): void {
  const s = state
  switch (ev.type) {
    case 'snapshot':
      setState({ snap: ev.data })
      break
    case 'task':
      setState({ snap: { ...s.snap, tasks: upsertBy(allTasks, ev.task, (t) => t.id) } })
      break
    case 'task-removed':
      setState({ snap: { ...s.snap, tasks: allTasks.filter((t) => t.id !== ev.id) } })
      break
    case 'backlog':
      // A project window gets its project's quests in the event (main filters them); the Hub refreshes.
      if (!PROJECT_WINDOW && s.snap.allies.some((a) => !a.retiredAt)) scheduleRefresh()
      else setState({ snap: { ...s.snap, backlog: ev.items } })
      break
    case 'plans':
      setState({ snap: { ...s.snap, plans: ev.plans } })
      break
    case 'decisions':
      if (s.snap.allies.some((a) => !a.retiredAt)) scheduleRefresh()
      else setState({ snap: { ...s.snap, decisions: ev.decisions } })
      break
    case 'projects':
      setState({ snap: { ...s.snap, projects: ev.projects } })
      break
    case 'standing-approvals':
      setState({ snap: { ...s.snap, standing: ev.approvals } })
      break
    case 'wksp':
      setState({ snap: { ...s.snap, wksps: upsertBy(s.snap.wksps, ev.wksp, (m) => m.name) } })
      break
    case 'chat': {
      const m = cleanChatMessage(ev.message)
      setState({ chats: { ...s.chats, [m.wksp]: applyChatEvent(s.chats[m.wksp] ?? [], m) } })
      break
    }
    case 'chat-delta':
      setState({ chats: { ...s.chats, [ev.wksp]: withDelta(s.chats[ev.wksp] ?? [], ev.wksp, ev.id, ev.text) } })
      break
    // A design chat's messages stay under its own key; only this window's project has them.
    case 'design-chats':
      if (ev.wksp === PROJECT_WKSP) setState({ designChats: ev.chats })
      break
    case 'design-chat': {
      if (ev.wksp !== PROJECT_WKSP) break
      const key = chatKey(ev.wksp, ev.conversation)
      setState({ chats: { ...s.chats, [key]: applyChatEvent(s.chats[key] ?? [], cleanChatMessage(ev.message)) } })
      break
    }
    case 'design-chat-delta': {
      if (ev.wksp !== PROJECT_WKSP) break
      const key = chatKey(ev.wksp, ev.conversation)
      setState({ chats: { ...s.chats, [key]: withDelta(s.chats[key] ?? [], ev.wksp, ev.id, ev.text) } })
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
    case 'tip':
      if (PROJECT_WINDOW && ev.project === PROJECT_WINDOW && !s.tip && s.settings?.featureTips !== false) {
        setState({ tip: { ...ev.tip, shownAt: Date.now() } })
      }
      break
    case 'toast':
      toast(ev.level, ev.title, ev.body)
      break
    case 'sign-in-needed':
      setState({ signIn: ev.tools, signInGate: ev.gate })
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
      if (s.settings?.voice) speak(ev.text, s.settings.replyVoice)
      break
    case 'speak-stop':
      stopSpeaking()
      break
    case 'navigate': {
      // a desktop notification was clicked
      const t = ev.target
      if (t.view === 'move') {
        const d = s.snap.decisions.find(d => d.id === t.decisionId)
        setState({ answersOpen: true, answerTarget: t.decisionId, answerHistory: d?.resolvedAt ? 'answered' : d?.held || (d?.until && Date.parse(d.until) > Date.now()) ? 'deferred' : undefined })
      }
      else if (t.view === 'squad') {
        if (t.taskId) focusTask(t.taskId)
        else go('squad')
      } else if (t.view === 'accounts') {
        void import('./lib/settings-nav').then((m) => m.openSettings('accounts'))
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
  // Raw output never relabels a ready unit (its idle CLI prints chrome too):
  // resumed work arrives as task and terminal events.
  window.genio.on(handleEvent)
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
    void api().signInNeeded().then((signIn) => setState({ signIn })).catch(() => undefined)
    void api().signInGate().then((signInGate) => setState({ signInGate })).catch(() => undefined)
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

/** The Squad page keeps only active units. */
export function liveTasks(s: State): FleetSnapshot['tasks'] {
  return squadRoster(s).active
}

/** Rail: active units, then recent finished units. Memoised per snapshot. */
type SquadRoster = Record<'active' | 'done', FleetSnapshot['tasks']>
let rosterCache: { tasks?: FleetSnapshot['tasks']; terminals?: State['terminals']; v: SquadRoster } = { v: { active: [], done: [] } }
export function squadRoster(s: State): SquadRoster {
  if (rosterCache.tasks !== s.snap.tasks || rosterCache.terminals !== s.terminals) {
    rosterCache = { tasks: s.snap.tasks, terminals: s.terminals, v: squadSections(s.snap.tasks, (t) => (t.terminalId ? s.terminals[t.terminalId] : undefined)) }
  }
  return rosterCache.v
}

/**
 * Choices asking now (the popup and its count); one set aside with Later or Ask Genio waits quietly under Deferred.
 * The same array until the decisions change or a deferral expires: always-mounted components select it, and a
 * new array per store change (every streamed delta) re-rendered them all.
 */
let openCache: { decisions?: FleetSnapshot['decisions']; until: number; v: FleetSnapshot['decisions'] } = { until: 0, v: [] }
export function openDecisions(s: State): FleetSnapshot['decisions'] {
  const now = Date.now()
  if (openCache.decisions === s.snap.decisions && now < openCache.until) return openCache.v
  // The next instant a deferred choice comes back, after which the list must be recomputed.
  const until = Math.min(Infinity, ...s.snap.decisions.map(d => (!d.resolvedAt && d.until ? Date.parse(d.until) : NaN)).filter(t => t > now))
  openCache = { decisions: s.snap.decisions, until, v: s.snap.decisions.filter(d => askingDecision(d, now)) }
  return openCache.v
}


export function toggleAnswers(): void {
  const pending = openDecisions(state).length > 0
  const visible = state.answersOpen && (pending || !!state.answerHistory)
  const setAside = state.snap.decisions.some(d => d.held && !d.resolvedAt)
  setState({
    answersOpen: !visible,
    answerTarget: undefined,
    answerHistory: pending ? undefined : !setAside && state.snap.decisions.some(d => d.resolvedAt) ? 'answered' : 'deferred'
  })
}

/** Answer next (Ctrl+J): show the cards and move keyboard focus to the first one. */
export function answerNext(): void {
  setState(s => ({ answersOpen: true, answerHistory: undefined, answerTarget: undefined, answerFocus: (s.answerFocus ?? 0) + 1 }))
}
