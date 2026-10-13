export type ViewId = 'inventory' | 'comms' | 'squad' | 'quests' | 'move' | 'status' | 'worlds' | 'lore' | 'systems' | 'fal' | 'animation'

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

export const ASSET_GEN: RailEntry & { kind: 'menu' } = {
  kind: 'menu',
  id: 'assets',
  label: 'Asset Generation',
  items: [
    { id: 'fal', label: 'FAL.ai', key: '' },
    { id: 'animation', label: 'Uthana (3D Rigging & Animation)', key: '0' }
  ]
}

const view = (id: ViewId, label: string, key: string): RailEntry => ({ kind: 'view', item: { id, label, key } })

export const RAIL: RailEntry[] = [
  view('comms', 'Comms', '1'),
  view('squad', 'Squad', '2'),
  view('quests', 'Quests', '3'),
  view('move', 'Your Move', '4'),
  view('status', 'Status', '5'),
  view('worlds', 'Worlds', '6'),
  view('lore', 'Lore', '7'),
  view('inventory', 'Inventory', '9'),
  view('systems', 'Systems', '8')
]

/** Every screen in rail order, submenus flattened (command palette, shortcuts). */
export function navItems(rail: RailEntry[] = RAIL): NavItem[] {
  return [...rail.flatMap((e) => (e.kind === 'view' ? [e.item] : e.items)), ...ASSET_GEN.items]
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
