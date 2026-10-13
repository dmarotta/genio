/**
 * Chat image attachments: the composer hook (paste / drag-and-drop into the
 * chat's draft), the thumbnail strip above the input, and the thumbnails +
 * full-size viewer in sent message bubbles.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { X } from 'lucide-react'
import { MAX_IMAGES_PER_MESSAGE, chatImageUrl, type ChatImage, type ChatImageInput } from '@shared/chat-images'
import { getDraftImages, setDraftImages, type DraftImage } from '../drafts'
import { toDraftImage } from '../lib/attach'
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

  const add = async (files: Blob[]): Promise<void> => {
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
      void add(files)
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
  const [open, setOpen] = useState<string>()
  return (
    <>
      <div className="msg-images">
        {images.map((img) => {
          const url = chatImageUrl(wksp, img.file)
          return (
            <button key={img.file} className="msg-image" onClick={() => setOpen(url)} title="View full size">
              <img src={url} alt="attached image" loading="lazy" />
            </button>
          )
        })}
      </div>
      {open && <ImageViewer url={open} onClose={() => setOpen(undefined)} />}
    </>
  )
}

function ImageViewer({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="image-viewer" onClick={onClose} role="dialog" aria-label="Image">
      <img src={url} alt="attached image" />
      <button className="btn sm ghost icon image-viewer-close" onClick={onClose} aria-label="Close">
        <X size={14} />
      </button>
    </div>
  )
}
