export type ViewId = 'play' | 'inventory' | 'comms' | 'squad' | 'quests' | 'status' | 'worlds' | 'systems'

/** One screen reachable from the rail; key is its Ctrl shortcut. */
export interface NavItem {
  id: ViewId
  label: string
  key: string
}

/** A rail button: a single screen, or a submenu grouping several. */
export type RailEntry =
  | { kind: 'view'; item: NavItem }
  | { kind: 'menu'; id: string; label: string; items: NavItem[] }

const view = (id: ViewId, label: string, key: string): RailEntry => ({ kind: 'view', item: { id, label, key } })

export const RAIL: RailEntry[] = [
  view('comms', 'Comms', '1'),
  view('squad', 'Squad', '2'),
  view('quests', 'Quests', '3'),
  view('status', 'Character Sheet', '5'),
  view('inventory', 'Inventory', '9'),
  view('play', 'Play', '0'),
  view('systems', 'Settings', '8')
]

/** Screens that only exist inside a project window. */
const PROJECT_VIEWS: ViewId[] = ['comms', 'inventory', 'play']

/** Whether a window offers this screen: the Hub has no project screens; Play needs a supported engine (see supportsPlay). */
export function viewAvailable(view: ViewId, projectWindow: boolean, play: boolean): boolean {
  if (!projectWindow && PROJECT_VIEWS.includes(view)) return false
  return view !== 'play' || play
}

/** The rail a window shows, keeping only the screens it offers. */
export function windowRail(projectWindow: boolean, play: boolean, rail: RailEntry[] = RAIL): RailEntry[] {
  return rail.flatMap((e): RailEntry[] => {
    if (e.kind === 'view') return viewAvailable(e.item.id, projectWindow, play) ? [e] : []
    const items = e.items.filter((i) => viewAvailable(i.id, projectWindow, play))
    return items.length ? [{ ...e, items }] : []
  })
}

/** Every screen in rail order, submenus flattened (command palette, shortcuts). */
export function navItems(rail: RailEntry[] = RAIL): NavItem[] {
  return rail.flatMap((e) => (e.kind === 'view' ? [e.item] : e.items))
}

/** A rail button lights up while its screen, or any screen in its submenu, is open. */
export function entryActive(e: RailEntry, current: ViewId): boolean {
  return e.kind === 'view' ? e.item.id === current : e.items.some((i) => i.id === current)
}

/** Item highlighted when a submenu opens: the current screen if it is in the menu, else the first. */
export function initialIndex(items: NavItem[], current: ViewId): number {
  return Math.max(0, items.findIndex((i) => i.id === current))
}

export type MenuAction = { type: 'move'; index: number } | { type: 'pick'; index: number } | { type: 'close' }

/** Keyboard handling inside an open submenu; null for keys the menu ignores. */
export function menuKey(key: string, index: number, count: number): MenuAction | null {
  switch (key) {
    case 'ArrowDown':
      return { type: 'move', index: (index + 1) % count }
    case 'ArrowUp':
      return { type: 'move', index: (index - 1 + count) % count }
    case 'Home':
      return { type: 'move', index: 0 }
    case 'End':
      return { type: 'move', index: count - 1 }
    case 'Enter':
    case ' ':
      return { type: 'pick', index }
    case 'Escape':
    case 'Tab':
    case 'ArrowLeft':
      return { type: 'close' }
    default:
      return null
  }
}

/** Keys on the rail button that open its submenu, besides Enter/Space (which click it). */
export function opensMenu(key: string): boolean {
  return key === 'ArrowDown' || key === 'ArrowRight'
}
