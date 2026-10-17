import { useLayoutEffect, useMemo, useRef, type MouseEvent } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { api } from '../store'

marked.setOptions({ gfm: true, breaks: true })

const SANITIZE = { ADD_ATTR: ['target'] }

export function renderMarkdown(src: string): string {
  const html = marked.parse(src ?? '', { async: false }) as string
  return DOMPurify.sanitize(html, SANITIZE)
}

/**
 * Rendered HTML by source, least recently used first, at most RENDERED_CHARS of source and HTML together: every
 * screen switch remounts a chat (the screen's or the floating one) and a message's HTML depends on its text only.
 */
const rendered = new Map<string, string>()
const RENDERED_CHARS = 4_000_000
let renderedChars = 0
export function cachedMarkdown(src: string): string {
  const hit = rendered.get(src)
  if (hit !== undefined) { rendered.delete(src); rendered.set(src, hit); return hit }
  const html = renderMarkdown(src)
  rendered.set(src, html)
  renderedChars += src.length + html.length
  for (const [key, value] of rendered) {
    if (renderedChars <= RENDERED_CHARS || rendered.size === 1) break
    rendered.delete(key)
    renderedChars -= key.length + value.length
  }
  return html
}

/** Links open in the system browser. */
function openLink(e: MouseEvent<HTMLDivElement>): void {
  const a = (e.target as HTMLElement).closest('a')
  if (a && a.getAttribute('href')) {
    e.preventDefault()
    const href = a.getAttribute('href')!
    if (/^https?:/i.test(href)) void api().openExternal(href)
  }
}

/**
 * Sanitized markdown; links open in the system browser. A `streaming` reply (it grows with every
 * delta) is rebuilt from its first changed block only, so each delta lays out its tail, not the whole reply.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const streaming = !!className?.split(' ').includes('streaming')
  // Different keys: the streamed element is never reused for the final render, nor the reverse.
  return streaming
    ? <StreamingMarkdown key="streaming" text={text} className={className!} />
    : <StaticMarkdown key="static" text={text} className={className} />
}

function StaticMarkdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => cachedMarkdown(text ?? ''), [text])
  return <div className={`md selectable ${className ?? ''}`} onClick={openLink} dangerouslySetInnerHTML={{ __html: html }} />
}

export interface StreamedBlocks { links: string; blocks: { raw: string; nodes: ChildNode[] }[] }

/**
 * The same DOM renderMarkdown builds (marked renders top-level tokens independently and joins them),
 * kept block by block: blocks whose source is unchanged keep their nodes; the rest are rebuilt in place.
 * A new link reference definition can change earlier blocks, so it rebuilds them all.
 */
export function updateStreamingBlocks(host: HTMLElement, state: StreamedBlocks, text: string): void {
  const tokens = marked.lexer(text ?? '')
  const links = JSON.stringify(tokens.links)
  let same = 0
  if (links === state.links) while (same < state.blocks.length && same < tokens.length && state.blocks[same].raw === tokens[same].raw) same++
  state.links = links
  for (const b of state.blocks.splice(same)) for (const n of b.nodes) n.remove()
  for (const token of tokens.slice(same)) {
    const html = marked.parser(Object.assign([token], { links: tokens.links }))
    const fragment = DOMPurify.sanitize(html, { ...SANITIZE, RETURN_DOM_FRAGMENT: true })
    const nodes = [...fragment.childNodes]
    host.append(fragment)
    state.blocks.push({ raw: token.raw, nodes })
  }
}

function StreamingMarkdown({ text, className }: { text: string; className: string }) {
  const host = useRef<HTMLDivElement>(null)
  const state = useRef<StreamedBlocks>({ links: '', blocks: [] })
  useLayoutEffect(() => { if (host.current) updateStreamingBlocks(host.current, state.current, text) }, [text])
  return <div ref={host} className={`md selectable ${className}`} onClick={openLink} />
}
