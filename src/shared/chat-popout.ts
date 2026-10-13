/** Only this exact same-page URL may create a native chat window. */
export const CHAT_POPOUT_HASH = '#genio-chat-panel'
export function isChatPopoutUrl(url: string, ownerUrl: string): boolean {
  try {
    const owner = new URL(ownerUrl)
    owner.hash = CHAT_POPOUT_HASH
    return new URL(url).href === owner.href
  } catch { return false }
}

export interface Rect { x: number; y: number; width: number; height: number }
export const POPOUT_MIN = { width: 360, height: 360 }
const TITLE_STRIP = 40

const overlap = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))

/**
 * Where a remembered pop-out may reopen: on the display its title bar overlaps most, fully inside that
 * work area. Undefined when no current display shows its title bar (monitor unplugged): the OS places it.
 */
export function visiblePopoutBounds(saved: Rect | undefined, workAreas: Rect[]): Rect | undefined {
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) return undefined
  const strip = { x: saved.x, y: saved.y, width: saved.width, height: TITLE_STRIP }
  const area = workAreas.map(a => ({ a, o: overlap(strip, a) })).filter(x => x.o > 0).sort((x, y) => y.o - x.o)[0]?.a
  return area && fitInto(saved, area)
}

/** The rect moved (and shrunk if needed) fully inside one work area. */
export function fitInto(saved: Rect, area: Rect): Rect {
  const width = Math.round(Math.min(area.width, Math.max(POPOUT_MIN.width, saved.width)))
  const height = Math.round(Math.min(area.height, Math.max(POPOUT_MIN.height, saved.height)))
  return {
    x: Math.round(Math.max(area.x, Math.min(area.x + area.width - width, saved.x))),
    y: Math.round(Math.max(area.y, Math.min(area.y + area.height - height, saved.y))),
    width, height
  }
}
