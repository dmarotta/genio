import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { api } from '../store'

marked.setOptions({ gfm: true, breaks: true })

export function renderMarkdown(src: string): string {
  const html = marked.parse(src ?? '', { async: false }) as string
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] })
}

/** Sanitized markdown; links open in the system browser. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return (
    <div
      className={`md selectable ${className ?? ''}`}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a')
        if (a && a.getAttribute('href')) {
          e.preventDefault()
          const href = a.getAttribute('href')!
          if (/^https?:/i.test(href)) void api().openExternal(href)
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
