/**
 * Chat image attachments: the composer hook (paste / drag-and-drop into the
 * chat's draft), the thumbnail strip above the input, and the thumbnails +
 * full-size viewer in sent message bubbles.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { MAX_IMAGES_PER_MESSAGE, chatImageUrl, type ChatImage, type ChatImageInput } from '@shared/chat-images'
import { getDraftImages, setDraftImages, type DraftImage } from '../drafts'
import { toDraftImage } from '../lib/attach'
import { fitImage, viewerClick, viewerKey, type ViewerAction } from '../lib/image-viewer'
import { errText, toast } from '../store'

const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer.types).includes('Files')

export interface Attachments {
  images: DraftImage[]
  /** images still being downscaled */
  pending: number
  dragging: boolean
  add(files: Blob[]): Promise<void>
  remove(id: string): void
  /** replace this chat's attachments (e.g. clear after sending, restore on failure) */
  set(images: DraftImage[]): void
  onPaste(e: ClipboardEvent): void
  dropProps: { onDragOver(e: DragEvent): void; onDragLeave(e: DragEvent): void; onDrop(e: DragEvent): void }
}

/** Images attached to one chat's draft; they live with the draft so they survive view switches. */
export function useAttachments(wksp: string, disabled = false): Attachments {
  const [images, setImages] = useState<DraftImage[]>(() => getDraftImages(wksp))
  const [pending, setPending] = useState(0)
  const [dragging, setDragging] = useState(false)
  const current = useRef(wksp)

  useLayoutEffect(() => {
    current.current = wksp
    setImages(getDraftImages(wksp))
  }, [wksp])

  const commit = (target: string, next: DraftImage[]): void => {
    setDraftImages(target, next)
    if (current.current === target) setImages(next)
  }

  const add = async (files: Blob[], pasted = false): Promise<void> => {
    const target = wksp
    const imgs = files.filter((f) => f.type.startsWith('image/'))
    if (!imgs.length) return
    const room = MAX_IMAGES_PER_MESSAGE - getDraftImages(target).length
    if (imgs.length > room) toast('error', 'Too many images', `At most ${MAX_IMAGES_PER_MESSAGE} images per message.`)
    const take = imgs.slice(0, Math.max(0, room))
    setPending((n) => n + take.length)
    for (const f of take) {
      try {
        const img = await toDraftImage(f)
        commit(target, [...getDraftImages(target), img].slice(0, MAX_IMAGES_PER_MESSAGE))
        if (pasted) void window.genio.api.featureUsed('screenshot').catch(() => {})
      } catch (e) {
        toast('error', 'Image not attached', errText(e))
      } finally {
        setPending((n) => n - 1)
      }
    }
  }

  return {
    images,
    pending,
    dragging,
    add,
    remove: (id) => commit(wksp, getDraftImages(wksp).filter((i) => i.id !== id)),
    set: (next) => commit(wksp, next),
    onPaste(e) {
      if (disabled) return
      const files = Array.from(e.clipboardData.items)
        .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
        .map((i) => i.getAsFile())
        .filter((f): f is File => !!f)
      if (!files.length) return
      // an image paste attaches; text pastes fall through to the textarea
      e.preventDefault()
      void add(files, true)
    },
    dropProps: {
      onDragOver(e) {
        if (disabled || !hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDragging(true)
      },
      onDragLeave(e) {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      },
      onDrop(e) {
        setDragging(false)
        if (disabled || !hasFiles(e)) return
        e.preventDefault()
        void add(Array.from(e.dataTransfer.files))
      }
    }
  }
}

/** Only the fields the session needs (no preview/id). */
export const toSendable = (images: DraftImage[]): ChatImageInput[] =>
  images.map(({ mediaType, data, width, height }) => ({ mediaType, data, width, height }))

let backSeq = 0

/** Images of a message taken back for editing, as draft attachments again. */
export const fromSendable = (images: readonly ChatImageInput[]): DraftImage[] =>
  images.map((i) => ({ ...i, id: `img-back-${Date.now()}-${backSeq++}`, preview: `data:${i.mediaType};base64,${i.data}` }))

/** Thumbnails above the composer input, each with a remove button. */
export function AttachmentStrip({ att }: { att: Attachments }) {
  if (!att.images.length && !att.pending) return null
  return (
    <div className="attach-strip">
      {att.images.map((img) => (
        <div key={img.id} className="attach-thumb">
          <img src={img.preview} alt="attached image" />
          <button className="attach-remove" onClick={() => att.remove(img.id)} aria-label="Remove image" title="Remove image">
            <X size={11} />
          </button>
        </div>
      ))}
      {Array.from({ length: att.pending }, (_, i) => (
        <div key={`p${i}`} className="attach-thumb loading" />
      ))}
    </div>
  )
}

/** Thumbnails in a sent message; click one to view it full size. */
export function MessageImages({ wksp, images }: { wksp: string; images: ChatImage[] }) {
  const [open, setOpen] = useState<number>()
  const urls = images.map((img) => chatImageUrl(wksp, img.file))
  return (
    <>
      <div className="msg-images">
        {urls.map((url, i) => (
          <button key={images[i].file} className="msg-image" onClick={() => setOpen(i)} title="View full size">
            <img src={url} alt="attached image" loading="lazy" />
          </button>
        ))}
      </div>
      {open !== undefined && <ImageViewer urls={urls} index={open} onIndex={setOpen} onClose={() => setOpen(undefined)} />}
    </>
  )
}

/** Pulsing tiles while Genio generates images; the message resolves into the images or an error. */
export function GeneratingImages({ count }: { count: number }) {
  return (
    <div className="msg-images" aria-label="Generating image" role="status">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="msg-image generating" />
      ))}
    </div>
  )
}

interface ViewerProps {
  urls: string[]
  index: number
  onIndex(i: number): void
  onClose(): void
}

/** Full-window overlay portalled to <body>, so the chat's scroll and the dock panes can't clip or move it. */
function ImageViewer({ urls, index, onIndex, onClose }: ViewerProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const [natural, setNatural] = useState<{ w: number; h: number }>()
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const act = (a: ViewerAction): void => {
    if (a.type === 'close') onClose()
    else if (a.type === 'show') onIndex(a.index)
  }
  const actRef = useRef(act)
  actRef.current = act
  const indexRef = useRef(index)
  indexRef.current = index

  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      const a = viewerKey(e.key, indexRef.current, urls.length)
      if (a.type === 'none') return
      e.preventDefault()
      e.stopPropagation()
      actRef.current(a)
    }
    const onResize = (): void => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onResize)
      document.body.style.overflow = prevOverflow
      prevFocus?.focus?.()
    }
  }, [urls.length])

  useEffect(() => setNatural(undefined), [index])

  const size = natural ? fitImage(natural.w, natural.h, viewport.w, viewport.h) : undefined
  const many = urls.length > 1
  return createPortal(
    <div
      className="image-viewer"
      onClick={(e) => act(viewerClick(e.target as Element))}
      role="dialog"
      aria-modal="true"
      aria-label="Image"
    >
      <img
        key={urls[index]}
        className="image-viewer-img"
        src={urls[index]}
        alt="attached image"
        style={size ? { width: size.width, height: size.height } : undefined}
        onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
      />
      {many && (
        <>
          <button className="image-viewer-nav prev" onClick={() => act(viewerKey('ArrowLeft', index, urls.length))} aria-label="Previous image">
            <ChevronLeft size={20} />
          </button>
          <button className="image-viewer-nav next" onClick={() => act(viewerKey('ArrowRight', index, urls.length))} aria-label="Next image">
            <ChevronRight size={20} />
          </button>
          <div className="image-viewer-count">
            {index + 1} / {urls.length}
          </div>
        </>
      )}
      <button ref={closeRef} className="image-viewer-close" onClick={(e) => { e.stopPropagation(); onClose() }} aria-label="Close" title="Close (Esc)">
        <X size={18} />
      </button>
    </div>,
    document.body
  )
}
