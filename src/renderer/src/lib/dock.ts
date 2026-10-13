/**
 * Dock layout for the chat screen: a tree of splits and tab groups, one panel
 * per chat (the main Genio chat plus one per ally). Pure functions only, so the
 * layout rules (main never closes, retired allies drop out, restore from disk)
 * are testable without a DOM.
 */
import type { Ally } from '@shared/types'
import type { AllyCreateRequest } from '@shared/api'

/** The main Genio chat: always in the layout, never closable. */
export const MAIN_PANEL = 'main'

export interface DockGroup {
  type: 'group'
  id: string
  /** panel ids = wksp names ('main' or an ally name), in tab order */
  tabs: string[]
  active: string
}

export interface DockSplit {
  type: 'split'
  id: string
  /** row = side by side, column = stacked */
  dir: 'row' | 'column'
  children: DockNode[]
  /** fractions of the split, one per child, summing to 1 */
  sizes: number[]
}

export type DockNode = DockGroup | DockSplit

export interface DockState {
  root: DockNode
  /** last panel the player interacted with; new tabs open next to it */
  focused: string
  /** allies the dock has already met; an ally not in here opens as a new tab */
  seen: string[]
  /** per panel, the timestamp of the newest message the player could see */
  lastSeen: Record<string, string>
}

export type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom'

let seq = 0
function nid(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${(++seq).toString(36)}`
}

export function group(tabs: string[], active = tabs[0]): DockGroup {
  return { type: 'group', id: nid('g'), tabs, active }
}

export function defaultDock(): DockState {
  return { root: group([MAIN_PANEL]), focused: MAIN_PANEL, seen: [], lastSeen: {} }
}

// ------------------------------------------------------------------ queries

export function groups(node: DockNode): DockGroup[] {
  return node.type === 'group' ? [node] : node.children.flatMap(groups)
}

export function openPanels(node: DockNode): string[] {
  return groups(node).flatMap((g) => g.tabs)
}

export function isOpen(state: DockState, panel: string): boolean {
  return openPanels(state.root).includes(panel)
}

export function groupOf(node: DockNode, panel: string): DockGroup | undefined {
  return groups(node).find((g) => g.tabs.includes(panel))
}

/** Panels the player can currently see: the active tab of every group. */
export function visiblePanels(node: DockNode): string[] {
  return groups(node).map((g) => g.active)
}

export function canClose(panel: string): boolean {
  return panel !== MAIN_PANEL
}

// ------------------------------------------------------------------ tree surgery

/** Rebuild a node bottom-up: drop empty groups, unwrap single-child splits, merge same-direction splits. */
function normalize(node: DockNode): DockNode | null {
  if (node.type === 'group') {
    if (!node.tabs.length) return null
    return node.tabs.includes(node.active) ? node : { ...node, active: node.tabs[0] }
  }
  const children: DockNode[] = []
  const sizes: number[] = []
  node.children.forEach((c, i) => {
    const n = normalize(c)
    if (!n) return
    const size = node.sizes[i] ?? 1 / node.children.length
    if (n.type === 'split' && n.dir === node.dir) {
      n.children.forEach((cc, j) => {
        children.push(cc)
        sizes.push(size * n.sizes[j])
      })
    } else {
      children.push(n)
      sizes.push(size)
    }
  })
  if (!children.length) return null
  if (children.length === 1) return children[0]
  const total = sizes.reduce((a, b) => a + b, 0) || 1
  return { ...node, children, sizes: sizes.map((s) => s / total) }
}

function mapGroups(node: DockNode, fn: (g: DockGroup) => DockNode): DockNode {
  if (node.type === 'group') return fn(node)
  return { ...node, children: node.children.map((c) => mapGroups(c, fn)) }
}

function withRoot(state: DockState, root: DockNode | null): DockState {
  // The main panel never leaves, so the root can only empty out mid-move; fall back to a fresh layout.
  return { ...state, root: root ?? group([MAIN_PANEL]) }
}

function removeFromTree(node: DockNode, panel: string): DockNode | null {
  return normalize(
    mapGroups(node, (g) => {
      if (!g.tabs.includes(panel)) return g
      const i = g.tabs.indexOf(panel)
      const tabs = g.tabs.filter((t) => t !== panel)
      const active = g.active === panel ? (tabs[Math.max(0, i - 1)] ?? '') : g.active
      return { ...g, tabs, active }
    })
  )
}

/** Hide a panel. The main chat cannot be closed: the state comes back unchanged. */
export function closePanel(state: DockState, panel: string): DockState {
  if (!canClose(panel) || !isOpen(state, panel)) return state
  const next = withRoot(state, removeFromTree(state.root, panel))
  const focused = state.focused === panel ? (groupOf(next.root, MAIN_PANEL)?.active ?? MAIN_PANEL) : state.focused
  return { ...next, focused }
}

/** Show a panel: focus it if it is open, otherwise add it as a tab in the focused group (or a given one). */
export function openPanel(state: DockState, panel: string, groupId?: string): DockState {
  const existing = groupOf(state.root, panel)
  if (existing) return focusPanel(state, panel)
  const target =
    groups(state.root).find((g) => g.id === groupId) ?? groupOf(state.root, state.focused) ?? groupOf(state.root, MAIN_PANEL) ?? groups(state.root)[0]
  const root = mapGroups(state.root, (g) => (g.id === target.id ? { ...g, tabs: [...g.tabs, panel], active: panel } : g))
  return { ...state, root, focused: panel, seen: state.seen.includes(panel) || panel === MAIN_PANEL ? state.seen : [...state.seen, panel] }
}

/** Make a panel the active tab of its group and the focused panel. */
export function focusPanel(state: DockState, panel: string): DockState {
  const g = groupOf(state.root, panel)
  if (!g) return state
  if (g.active === panel && state.focused === panel) return state
  const root = g.active === panel ? state.root : mapGroups(state.root, (x) => (x.id === g.id ? { ...x, active: panel } : x))
  return { ...state, root, focused: panel }
}

/**
 * Drag-and-drop: move a panel into a group (center, optionally at a tab index)
 * or split that group by docking the panel on one of its edges.
 */
export function movePanel(state: DockState, panel: string, targetGroupId: string, zone: DropZone, index?: number): DockState {
  const source = groupOf(state.root, panel)
  const target = groups(state.root).find((g) => g.id === targetGroupId)
  if (!source || !target) return state
  if (zone === 'center') {
    if (source.id === target.id) {
      const tabs = source.tabs.filter((t) => t !== panel)
      const at = index === undefined ? tabs.length : Math.max(0, Math.min(tabs.length, index > source.tabs.indexOf(panel) ? index - 1 : index))
      tabs.splice(at, 0, panel)
      const root = mapGroups(state.root, (g) => (g.id === source.id ? { ...g, tabs, active: panel } : g))
      return { ...state, root, focused: panel }
    }
    const removed = removeFromTree(state.root, panel)
    if (!removed) return state
    const root = mapGroups(removed, (g) => {
      if (g.id !== target.id) return g
      const tabs = g.tabs.slice()
      tabs.splice(index === undefined ? tabs.length : Math.max(0, Math.min(tabs.length, index)), 0, panel)
      return { ...g, tabs, active: panel }
    })
    return { ...state, root, focused: panel }
  }
  // Splitting a group by its only tab would leave an empty pane behind.
  if (source.id === target.id && source.tabs.length === 1) return state
  const removed = removeFromTree(state.root, panel)
  if (!removed) return state
  const dir: DockSplit['dir'] = zone === 'left' || zone === 'right' ? 'row' : 'column'
  const before = zone === 'left' || zone === 'top'
  const fresh = group([panel])
  const root = normalize(
    mapGroups(removed, (g) => {
      if (g.id !== target.id) return g
      return { type: 'split', id: nid('s'), dir, children: before ? [fresh, g] : [g, fresh], sizes: [0.5, 0.5] }
    })
  )
  return { ...withRoot(state, root), focused: panel }
}

/** Resize a split; every child keeps at least 8% so no pane can vanish. */
export function resizeSplit(state: DockState, splitId: string, sizes: number[]): DockState {
  const walk = (node: DockNode): DockNode => {
    if (node.type === 'group') return node
    if (node.id === splitId && sizes.length === node.children.length) {
      const clamped = sizes.map((s) => Math.max(0.08, s))
      const total = clamped.reduce((a, b) => a + b, 0)
      return { ...node, sizes: clamped.map((s) => s / total) }
    }
    return { ...node, children: node.children.map(walk) }
  }
  return { ...state, root: walk(state.root) }
}

// ------------------------------------------------------------------ layout metrics

/** Smallest usable pane: room for the tab strip, the chat header, a little log and the composer. */
export const MIN_PANE = { width: 260, height: 260 }
/** Thickness of the resize sash between split children, in px (matches .dock-sash in app.css). */
export const SASH_PX = 7

/** Minimum pixel size of a subtree along an axis: children add up along their split, the largest wins across it. */
export function minSize(node: DockNode, axis: DockSplit['dir']): number {
  if (node.type === 'group') return axis === 'row' ? MIN_PANE.width : MIN_PANE.height
  const kids = node.children.map((c) => minSize(c, axis))
  return node.dir === axis ? kids.reduce((a, b) => a + b, 0) + SASH_PX * (kids.length - 1) : Math.max(...kids)
}

/**
 * New split sizes after dragging the sash behind child i by deltaPx. Only the
 * two neighbours change. px is their rendered size at drag start, min their
 * pixel minimums; a pair too small for both minimums splits by those minimums.
 */
export function dragSash(sizes: number[], i: number, px: [number, number], deltaPx: number, min: [number, number]): number[] {
  const pairPx = px[0] + px[1]
  if (i < 0 || i + 1 >= sizes.length || pairPx <= 0) return sizes
  let lo = min[0]
  let hi = pairPx - min[1]
  if (lo > hi) lo = hi = (pairPx * min[0]) / (min[0] + min[1] || 1)
  const a = Math.min(hi, Math.max(lo, px[0] + deltaPx))
  const pair = sizes[i] + sizes[i + 1]
  const out = sizes.slice()
  out[i] = (pair * a) / pairPx
  out[i + 1] = pair - out[i]
  return out
}

/** Record what the player has seen of a panel (newest message timestamp). */
export function markSeen(state: DockState, panel: string, ts: string): DockState {
  const cur = state.lastSeen[panel]
  if (cur && cur >= ts) return state
  return { ...state, lastSeen: { ...state.lastSeen, [panel]: ts } }
}

/** True when the chat has a non-player message newer than what the player last saw. */
export function hasUnread(state: DockState, panel: string, messages: { role: string; ts: string }[]): boolean {
  const seen = state.lastSeen[panel]
  if (!seen) return false
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.ts <= seen) return false
    if (m.role !== 'player') return true
  }
  return false
}

/**
 * Bring a layout in line with the live allies: panels for retired or missing
 * allies are dropped, the main chat is guaranteed, and allies the dock has
 * never met open as new tabs next to the main chat.
 */
export function reconcileDock(state: DockState, allies: Ally[], now = new Date().toISOString()): DockState {
  const active = new Set(allies.filter((a) => !a.retiredAt).map((a) => a.name))
  const keep = (p: string): boolean => p === MAIN_PANEL || active.has(p)
  const dupes = new Set<string>()
  let root = normalize(
    mapGroups(state.root, (g) => {
      const tabs = g.tabs.filter((t) => {
        if (!keep(t) || dupes.has(t)) return false
        dupes.add(t)
        return true
      })
      return { ...g, tabs, active: tabs.includes(g.active) ? g.active : (tabs[0] ?? '') }
    })
  )
  if (!root) root = group([MAIN_PANEL])
  else if (!openPanels(root).includes(MAIN_PANEL)) {
    const first = groups(root)[0]
    root = mapGroups(root, (g) => (g.id === first.id ? { ...g, tabs: [MAIN_PANEL, ...g.tabs] } : g))
  }
  let next: DockState = {
    root,
    focused: openPanels(root).includes(state.focused) ? state.focused : MAIN_PANEL,
    seen: state.seen.filter((s) => active.has(s)),
    lastSeen: Object.fromEntries(Object.entries(state.lastSeen).filter(([k]) => keep(k)))
  }
  // A newly met ally joins the main chat's group as a background tab (it does not steal the view).
  for (const name of [...active].filter((a) => !next.seen.includes(a))) {
    const home = groupOf(next.root, MAIN_PANEL) as DockGroup
    next = {
      ...next,
      root: openPanels(next.root).includes(name) ? next.root : mapGroups(next.root, (g) => (g.id === home.id ? { ...g, tabs: [...g.tabs, name] } : g)),
      seen: [...next.seen, name],
      lastSeen: next.lastSeen[name] ? next.lastSeen : { ...next.lastSeen, [name]: now }
    }
  }
  if (!next.lastSeen[MAIN_PANEL]) next = { ...next, lastSeen: { ...next.lastSeen, [MAIN_PANEL]: now } }
  return next
}

// ------------------------------------------------------------------ persistence

export const DOCK_STORAGE_KEY = 'genio.dock.v1'

function validNode(n: unknown, depth = 0): n is DockNode {
  if (!n || typeof n !== 'object' || depth > 12) return false
  const o = n as Record<string, unknown>
  if (typeof o.id !== 'string') return false
  if (o.type === 'group') return Array.isArray(o.tabs) && o.tabs.every((t) => typeof t === 'string') && typeof o.active === 'string'
  if (o.type === 'split') {
    return (
      (o.dir === 'row' || o.dir === 'column') &&
      Array.isArray(o.children) &&
      Array.isArray(o.sizes) &&
      o.sizes.length === o.children.length &&
      o.sizes.every((s) => typeof s === 'number' && Number.isFinite(s) && s > 0) &&
      o.children.every((c) => validNode(c, depth + 1))
    )
  }
  return false
}

export function serializeDock(state: DockState): string {
  return JSON.stringify({ v: 1, ...state })
}

/** Parse a saved layout; anything malformed falls back to the default layout. */
export function parseDock(raw: string | null | undefined): DockState {
  if (!raw) return defaultDock()
  try {
    const o = JSON.parse(raw) as Partial<DockState> & { v?: number }
    if (o.v !== 1 || !validNode(o.root)) return defaultDock()
    const root = normalize(o.root) ?? group([MAIN_PANEL])
    return {
      root,
      focused: typeof o.focused === 'string' ? o.focused : MAIN_PANEL,
      seen: Array.isArray(o.seen) ? o.seen.filter((s): s is string => typeof s === 'string') : [],
      lastSeen:
        o.lastSeen && typeof o.lastSeen === 'object'
          ? Object.fromEntries(Object.entries(o.lastSeen).filter(([, v]) => typeof v === 'string'))
          : {}
    }
  } catch {
    return defaultDock()
  }
}

// ------------------------------------------------------------------ ally per world

const ALLY_NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/

/** The ally name for a world: the world's name, folded to the ally name rules. */
export function allyNameForWorld(world: string): string {
  let n = world
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 31)
    .replace(/-+$/, '')
  if (n === MAIN_PANEL) n = 'main-world'
  if (n.length < 2) n = `world-${n || 'ally'}`.slice(0, 31)
  return ALLY_NAME_RE.test(n) ? n : 'world-ally'
}

/** The live ally that belongs to a world: named after it, or scoped to exactly that world. */
export function allyForWorld(allies: Ally[], world: string): Ally | undefined {
  const live = allies.filter((a) => !a.retiredAt)
  const name = allyNameForWorld(world)
  return live.find((a) => a.name === name) ?? live.find((a) => a.projects.length === 1 && a.projects[0] === world)
}

export function worldAllyRequest(world: string): AllyCreateRequest {
  return { name: allyNameForWorld(world), scope: `All work in ${world}`, charter: '', projects: [world], model: undefined }
}

export interface SpawnDeps {
  allies(): Ally[]
  create(req: AllyCreateRequest): Promise<Ally>
  /** show the ally's tab */
  open(ally: Ally): void
}

const inflight = new Map<string, Promise<Ally>>()

/**
 * Spawn (or reopen) the ally for a world. Idempotent: an existing ally just gets
 * its tab focused, and concurrent calls for the same world share one creation.
 */
export function spawnWorldAlly(world: string, deps: SpawnDeps): Promise<Ally> {
  const existing = allyForWorld(deps.allies(), world)
  if (existing) {
    deps.open(existing)
    return Promise.resolve(existing)
  }
  const pending = inflight.get(world)
  if (pending) return pending
  const p = deps
    .create(worldAllyRequest(world))
    .then((a) => {
      deps.open(a)
      return a
    })
    .finally(() => inflight.delete(world))
  inflight.set(world, p)
  return p
}
