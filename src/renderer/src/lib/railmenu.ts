export type ViewId = 'play' | 'inventory' | 'art-bible' | 'design' | 'comms' | 'squad' | 'quests' | 'status' | 'worlds' | 'systems'

/** One screen reachable from the rail; key is its Ctrl shortcut. */
export interface NavItem {
  id: ViewId
  label: string
  key: string
}

/** A rail button: one screen. */
export type RailEntry = { kind: 'view'; item: NavItem }

const view = (id: ViewId, label: string, key: string): RailEntry => ({ kind: 'view', item: { id, label, key } })

export const RAIL: RailEntry[] = [
  view('comms', 'Comms', '1'),
  view('squad', 'Squad', '2'),
  view('quests', 'Quests', '3'),
  view('design', 'Design', '7'),
  view('status', 'Character Sheet', '5'),
  view('inventory', 'Inventory', '9'),
  view('art-bible', 'Art Bible', '6'),
  view('play', 'Play', '0'),
  view('systems', 'Settings', '8')
]

/** Screens that only exist inside a project window. */
const PROJECT_VIEWS: ViewId[] = ['comms', 'design', 'inventory', 'art-bible', 'play']

/** Whether a window offers this screen: the Hub has no project screens; Play needs a supported engine (supportsUnitySlots). */
export function viewAvailable(view: ViewId, projectWindow: boolean, play: boolean): boolean {
  if (!projectWindow && PROJECT_VIEWS.includes(view)) return false
  return view !== 'play' || play
}

/** The rail a window shows, keeping only the screens it offers. */
export function windowRail(projectWindow: boolean, play: boolean, rail: RailEntry[] = RAIL): RailEntry[] {
  return rail.filter((e) => viewAvailable(e.item.id, projectWindow, play))
}

/** Every screen in rail order (command palette, shortcuts). */
export function navItems(rail: RailEntry[] = RAIL): NavItem[] {
  return rail.map((e) => e.item)
}

export type MenuAction = { type: 'move'; index: number } | { type: 'pick'; index: number } | { type: 'close' }

/** Keyboard handling inside an open menu (the File menu); null for keys the menu ignores. */
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
