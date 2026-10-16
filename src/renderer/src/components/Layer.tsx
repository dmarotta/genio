import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useChatDocument } from './ChatDocument'

/**
 * Every modal, confirm, menu, popover and toast renders here: one root at the end of <body>, outside
 * the pages. A page's chamfered .panel (clip-path), a scroll box or an animating transform would
 * otherwise clip or move a dialog even with position: fixed.
 */
export const LAYER_ROOT_ID = 'genio-layer'

export function layerRoot(doc: Document = document): HTMLElement {
  let root = doc.getElementById(LAYER_ROOT_ID)
  if (!root) {
    root = doc.createElement('div')
    root.id = LAYER_ROOT_ID
    doc.body.appendChild(root)
  }
  return root
}

/** Renders its children into the layer root of this window (the popped-out chat has its own). */
export function Layer({ children }: { children: ReactNode }) {
  return createPortal(children, layerRoot(useChatDocument()))
}

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

function focusables(el: HTMLElement): HTMLElement[] {
  const view = el.ownerDocument.defaultView
  return [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => !n.closest('[hidden]') && view?.getComputedStyle(n).display !== 'none')
}

/** Open dialogs, topmost last: only the top one answers Esc and keeps Tab. */
const dialogs: HTMLElement[] = []

/**
 * A modal layer: a backdrop over the whole window with its content centred and scrollable when
 * taller than the window. Focus moves in and stays in (Tab wraps), Esc and a backdrop click close
 * unless `dismissible` is false, and focus returns to where it was when the dialog closes.
 */
export function Dialog({
  onClose,
  dismissible = true,
  strong,
  label,
  labelledBy,
  className,
  children
}: {
  onClose?: () => void
  dismissible?: boolean
  strong?: boolean
  label?: string
  labelledBy?: string
  className?: string
  children: ReactNode
}) {
  const doc = useChatDocument()
  const ref = useRef<HTMLDivElement>(null)
  // Read before the dialog mounts: an autoFocus field inside takes focus during the commit.
  const [opener] = useState(() => doc.activeElement as HTMLElement | null)
  const close = useRef(onClose)
  close.current = dismissible ? onClose : undefined

  useEffect(() => {
    const el = ref.current!
    const win = doc.defaultView!
    dialogs.push(el)
    if (!el.contains(doc.activeElement)) {
      const all = focusables(el)
      ;(all.find((n) => !n.closest('.modal-head')) ?? all[0] ?? el).focus({ preventScroll: true })
    }
    const onKey = (e: KeyboardEvent): void => {
      if (dialogs[dialogs.length - 1] !== el || e.defaultPrevented) return
      // Keys from a menu or picker portalled out of this dialog belong to that menu.
      const target = e.target as Node | null
      if (target && target !== doc.body && target !== doc.documentElement && !el.contains(target)) return
      if (e.key === 'Escape') {
        if (!close.current) return
        e.preventDefault()
        close.current()
      } else if (e.key === 'Tab') {
        const all = focusables(el)
        if (!all.length) { e.preventDefault(); el.focus(); return }
        const at = all.indexOf(doc.activeElement as HTMLElement)
        if (e.shiftKey && at <= 0) { e.preventDefault(); all[all.length - 1].focus() }
        else if (!e.shiftKey && (at === -1 || at === all.length - 1)) { e.preventDefault(); all[0].focus() }
      }
    }
    win.addEventListener('keydown', onKey)
    return () => {
      win.removeEventListener('keydown', onKey)
      dialogs.splice(dialogs.indexOf(el), 1)
      const lost = !doc.activeElement || doc.activeElement === doc.body || el.contains(doc.activeElement)
      if (lost && opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [doc, opener])

  return (
    <Layer>
      <div
        ref={ref}
        className={['modal-scrim', strong && 'strong', className].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onMouseDown={(e) => e.target === e.currentTarget && close.current?.()}
      >
        {children}
      </div>
    </Layer>
  )
}

export type Placement = 'bottom-start' | 'bottom-end' | 'right-start' | 'right-end' | 'top-span'
type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number }

/** Window margin a popover keeps clear of. */
const EDGE = 8

/**
 * Where a popover goes beside its anchor, in window coordinates: flipped to the other side when it
 * would leave the window and there is room there, then clamped inside the window. `top-span` sits
 * above the anchor across the width of `span` (the chat's slash menu above the composer).
 */
export function popoverPosition(
  placement: Placement,
  anchor: Box,
  size: { width: number; height: number },
  view: { width: number; height: number },
  gap = 6,
  span: Box = anchor
): { left: number; top: number; width?: number; maxHeight: number } {
  const clamp = (v: number, size: number, room: number): number => Math.max(EDGE, Math.min(v, room - size - EDGE))
  if (placement === 'top-span') {
    const top = Math.max(EDGE, anchor.top - gap - size.height)
    return { left: span.left, top, width: span.width, maxHeight: Math.max(0, anchor.top - gap - EDGE) }
  }
  const maxHeight = view.height - 2 * EDGE
  if (placement === 'bottom-start' || placement === 'bottom-end') {
    let top = anchor.bottom + gap
    if (top + size.height > view.height - EDGE && anchor.top - gap - size.height >= EDGE) top = anchor.top - gap - size.height
    const left = placement === 'bottom-start' ? anchor.left : anchor.right - size.width
    return { left: clamp(left, size.width, view.width), top: clamp(top, size.height, view.height), maxHeight }
  }
  let left = anchor.right + gap
  if (left + size.width > view.width - EDGE && anchor.left - gap - size.width >= EDGE) left = anchor.left - gap - size.width
  const top = placement === 'right-start' ? anchor.top : anchor.bottom - size.height
  return { left: clamp(left, size.width, view.width), top: clamp(top, size.height, view.height), maxHeight }
}

/**
 * A menu or popover anchored to a control but rendered in the layer root, so no panel clips it.
 * A pointer down outside it and its anchor, or Esc, calls onClose (with how it was dismissed).
 * `fit` caps its height to the window and scrolls inside; a menu with a side submenu turns it off.
 */
export function Popover({
  anchor,
  panel,
  span,
  placement = 'bottom-start',
  gap = 6,
  fit = true,
  onClose,
  className,
  style,
  children,
  ...rest
}: {
  anchor: RefObject<HTMLElement | null>
  /** Also set to the popover element, for callers that focus or measure inside it. */
  panel?: RefObject<HTMLDivElement | null>
  span?: RefObject<HTMLElement | null>
  placement?: Placement
  gap?: number
  fit?: boolean
  onClose?: (how: 'outside' | 'escape') => void
  children: ReactNode
} & HTMLAttributes<HTMLDivElement>) {
  const doc = useChatDocument()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<ReturnType<typeof popoverPosition>>()
  const close = useRef(onClose)
  close.current = onClose

  useLayoutEffect(() => {
    const win = doc.defaultView!
    const place = (): void => {
      const a = anchor.current, el = ref.current
      if (!a || !el) return
      const next = popoverPosition(placement, a.getBoundingClientRect(), { width: el.offsetWidth, height: el.offsetHeight },
        { width: win.innerWidth, height: win.innerHeight }, gap, span?.current?.getBoundingClientRect())
      setPos((p) => (p && p.left === next.left && p.top === next.top && p.width === next.width && p.maxHeight === next.maxHeight ? p : next))
    }
    place()
    win.addEventListener('resize', place)
    doc.addEventListener('scroll', place, true)
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place)
    if (ref.current) ro?.observe(ref.current)
    if (anchor.current) ro?.observe(anchor.current)
    return () => {
      win.removeEventListener('resize', place)
      doc.removeEventListener('scroll', place, true)
      ro?.disconnect()
    }
  }, [doc, anchor, span, placement, gap])

  useEffect(() => {
    const away = (e: Event): void => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !anchor.current?.contains(t)) close.current?.('outside')
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || !close.current) return
      e.preventDefault()
      close.current('escape')
    }
    doc.addEventListener('mousedown', away)
    doc.addEventListener('keydown', esc)
    return () => {
      doc.removeEventListener('mousedown', away)
      doc.removeEventListener('keydown', esc)
    }
  }, [doc, anchor])

  // Placed before the first paint; never hidden, so a menu can focus its first item as it opens.
  const placed: CSSProperties = {
    position: 'fixed', zIndex: 280, right: 'auto', bottom: 'auto', margin: 0,
    left: pos?.left ?? 0, top: pos?.top ?? 0,
    ...(pos?.width !== undefined && { width: pos.width, maxWidth: 'none' }),
    ...(fit && pos && { maxHeight: pos.maxHeight, overflowY: 'auto' })
  }
  return (
    <Layer>
      <div ref={(el) => { ref.current = el; if (panel) panel.current = el }} className={className} style={{ ...style, ...placed }} {...rest}>
        {children}
      </div>
    </Layer>
  )
}
