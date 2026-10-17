import { useState, type ReactNode } from 'react'
import { Check, Eye, Pencil } from 'lucide-react'
import { Markdown } from './Markdown'
import { cx } from '../lib/format'

/**
 * A plain markdown file's editor, in the Memory editor pattern: one textarea, Preview, Ctrl+S, the size against
 * its limit. The Art Bible's Markdown tab and the Design screen's notes use it. With `onCancel` (a note), Cancel
 * drops the draft and leaves the editor, and Preview is left to the view it came from.
 */
export function MarkdownEditor({ head, label, text, dirty, maxBytes, warnBytes, sizeTitle, hint, className, onChange, onSave, onDiscard, onCancel }: {
  head?: ReactNode
  /** the textarea's accessible name */
  label: string
  text: string
  dirty: boolean
  maxBytes: number
  warnBytes?: number
  sizeTitle?: string
  hint?: ReactNode
  className?: string
  onChange: (text: string) => void
  onSave: () => void
  onDiscard: () => void
  onCancel?: () => void
}) {
  const [preview, setPreview] = useState(false)
  const bytes = new TextEncoder().encode(text).length
  return (
    <section className={cx('memory-editor', className)}>
      <div className="memory-top">
        {head ?? <span />}
        <div className="memory-tools">
          <span className={cx('mono', bytes > maxBytes ? 'alert-text' : warnBytes !== undefined && bytes > warnBytes ? 'amber-text' : 'mute')} title={sizeTitle}>
            {(bytes / 1024).toFixed(1)} KB
          </span>
          {!onCancel && (
            <button className={cx('btn sm ghost', preview && 'on')} onClick={() => setPreview(p => !p)}>
              {preview ? <Pencil size={12} /> : <Eye size={12} />} {preview ? 'Edit' : 'Preview'}
            </button>
          )}
          {onCancel
            ? <button className="btn sm ghost" onClick={onCancel}>Cancel</button>
            : dirty && <button className="btn sm ghost" onClick={onDiscard}>Discard</button>}
          <button className="btn sm solid" disabled={!dirty} onClick={onSave}>
            <Check size={12} /> Save file
          </button>
        </div>
      </div>
      {hint && <div className="mute memory-hint">{hint}</div>}
      {preview ? (
        <div className="memory-preview">
          <Markdown text={text} />
        </div>
      ) : (
        <textarea
          className="textarea mono memory-text"
          aria-label={label}
          value={text}
          spellCheck={false}
          autoFocus={!!onCancel}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              onSave()
            }
          }}
        />
      )}
    </section>
  )
}
