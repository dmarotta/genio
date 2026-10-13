/** Pure behaviour of the chat image viewer overlay, kept apart from React so it can be tested in node. */

export type ViewerAction = { type: 'close' } | { type: 'show'; index: number } | { type: 'none' }

const NONE: ViewerAction = { type: 'none' }

/** What a key press does while the viewer shows image `index` of `count`. */
export function viewerKey(key: string, index: number, count: number): ViewerAction {
  if (key === 'Escape') return { type: 'close' }
  if (count < 2) return NONE
  if (key === 'ArrowLeft') return { type: 'show', index: (index - 1 + count) % count }
  if (key === 'ArrowRight') return { type: 'show', index: (index + 1) % count }
  return NONE
}

/** A click closes the viewer unless it landed on the image or a control inside the overlay. */
export function viewerClick(target: { closest(sel: string): unknown } | null): ViewerAction {
  if (target?.closest('.image-viewer-img, .image-viewer-nav')) return NONE
  return { type: 'close' }
}

/**
 * Display size for an image of natural size w×h in a viewport vw×vh: fit within 95% of the viewport,
 * never upscaled, except images under 40% of the viewport which may grow up to 1.5×.
 */
export function fitImage(w: number, h: number, vw: number, vh: number): { width: number; height: number } {
  if (!w || !h) return { width: w, height: h }
  const fit = Math.min((vw * 0.95) / w, (vh * 0.95) / h)
  const small = w < vw * 0.4 && h < vh * 0.4
  const scale = Math.min(fit, small ? 1.5 : 1)
  return { width: Math.round(w * scale), height: Math.round(h * scale) }
}
