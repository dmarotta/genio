import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api, useStore } from '../store'
import { onTerminal } from '../lib/termbus'
import { cx } from '../lib/format'

const THEME = {
  background: '#05070b',
  foreground: '#d6e4f5',
  cursor: '#00e5ff',
  cursorAccent: '#05070b',
  selectionBackground: 'rgba(0, 229, 255, 0.30)',
  black: '#0c0f16',
  red: '#ff2e6e',
  green: '#c6ff3d',
  yellow: '#ffb627',
  blue: '#4d9dff',
  magenta: '#a56bff',
  cyan: '#00e5ff',
  white: '#d6e4f5',
  brightBlack: '#546175',
  brightRed: '#ff6b98',
  brightGreen: '#dcff85',
  brightYellow: '#ffd27a',
  brightBlue: '#82bbff',
  brightMagenta: '#c7a2ff',
  brightCyan: '#7af3ff',
  brightWhite: '#ffffff'
}

/**
 * Live view of a main-process PTY. Writes scrollback on attach, then streams.
 * A shell takes its size from the view and keyboard input goes straight to it.
 * A `passive` view (a unit's agent) only watches: it keeps the PTY's own size,
 * scaled down to fit, and sends no keys (Ctrl+C included) until the player
 * clicks into it; from then on it fits the PTY to the view and takes input.
 * The player's terminal pane (`pane`) adds clickable links, copy and paste (Ctrl+C with a selection,
 * Ctrl+V, Ctrl+Shift+C/V, right click) and leaves Ctrl+` to the pane toggle.
 */
export function TerminalView({ id, fontSize = 12, interactive = true, autoFocus = false, passive = false, pane = false }: { id: string; fontSize?: number; interactive?: boolean; autoFocus?: boolean; passive?: boolean; pane?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const info = useStore((s) => s.terminals[id])
  const size = useRef(info)
  size.current = info
  const claim = useRef<(() => void) | undefined>(undefined)
  const [claimed, setClaimed] = useState(!passive)

  useEffect(() => {
    const el = host.current
    if (!el) return
    let owned = !passive
    setClaimed(owned)
    const term = new XTerm({
      fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
      fontSize,
      lineHeight: 1.15,
      cursorBlink: interactive,
      cursorStyle: 'bar',
      scrollback: 8000,
      allowTransparency: false,
      disableStdin: !interactive,
      theme: THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    let disposed = false
    let attached = false
    let opened = false
    let extras: (() => void) | undefined
    const pending: string[] = []

    const unsub = onTerminal(id, (data) => {
      if (!attached) pending.push(data)
      else term.write(data)
    })

    // Watching never resizes the agent's PTY: mirror its size and scale the screen to the box.
    const mirror = (): void => {
      const pty = size.current
      if (pty && (term.cols !== pty.cols || term.rows !== pty.rows)) term.resize(pty.cols, pty.rows)
      const screen = term.element
      if (!screen) return
      screen.style.transform = ''
      const scale = Math.min(1, el.clientWidth / (screen.offsetWidth || 1), el.clientHeight / (screen.offsetHeight || 1))
      screen.style.transformOrigin = '0 0'
      screen.style.transform = scale < 1 ? `scale(${scale})` : ''
    }

    const doFit = (): void => {
      if (disposed || !opened) return
      if (!owned) return mirror()
      try {
        if (term.element) term.element.style.transform = ''
        fit.fit()
        void api().terminalResize(id, term.cols, term.rows).catch(() => undefined)
      } catch {
        /* not visible yet */
      }
    }

    claim.current = () => {
      if (owned || !interactive || disposed) return
      owned = true
      setClaimed(true)
      doFit()
      term.focus()
    }

    // The scrollback (up to 1.5 MB) is parsed before the terminal joins the page. Opened first, xterm rebuilt its
    // screen every frame while it parsed, measuring each new glyph with a forced style pass over the rows drawn so
    // far: seconds of style work on Squad's cards. Opened after, it draws once.
    const open = (): void => {
      if (opened || disposed) return
      opened = true
      term.open(el)
      extras = pane ? paneExtras(term) : undefined
      requestAnimationFrame(doFit)
      if (autoFocus && owned) term.focus()
    }

    void api()
      .terminalAttach(id)
      .then((scroll) => {
        if (disposed) return
        // A watched agent's output is laid out at its PTY's size (mirror() keeps that size once open).
        const pty = size.current
        if (!owned && pty && pty.cols > 1 && pty.rows > 1) term.resize(pty.cols, pty.rows)
        if (scroll) term.write(scroll)
        for (const p of pending) term.write(p)
        pending.length = 0
        attached = true
        term.write('', open)
      })
      .catch((e) => {
        attached = true
        open()
        term.write(`\r\n\x1b[38;2;255;46;110m[no signal] ${String(e?.message ?? e)}\x1b[0m\r\n`)
      })

    const sub = term.onData((d) => {
      if (interactive && owned) void api().terminalWrite(id, d).catch(() => undefined)
    })

    let t: number | undefined
    const ro = new ResizeObserver(() => {
      if (t) window.clearTimeout(t)
      t = window.setTimeout(doFit, 60)
    })
    ro.observe(el)

    return () => {
      disposed = true
      claim.current = undefined
      ro.disconnect()
      sub.dispose()
      unsub()
      extras?.()
      term.dispose()
    }
  }, [id, fontSize, interactive, autoFocus, passive, pane])

  return (
    <>
      <div
        className={cx('term-host', !claimed && 'passive')}
        ref={host}
        onMouseDown={(e) => {
          e.stopPropagation()
          claim.current?.()
        }}
      />
      {!claimed && interactive && <div className="term-claim mute">Click to type into the agent</div>}
    </>
  )
}

const URL_RE = /https?:\/\/[^\s"'<>`]+[^\s"'<>`.,;:!?)\]}]/g

/** Links, clipboard and the pane shortcut for the player's own terminal; returns its cleanup. */
function paneExtras(term: XTerm): () => void {
  const copy = (): boolean => {
    const text = term.getSelection()
    if (!text) return false
    void navigator.clipboard?.writeText(text).catch(() => undefined)
    term.clearSelection()
    return true
  }
  const paste = (): void => {
    void navigator.clipboard?.readText().then((t) => { if (t) term.paste(t) }).catch(() => undefined)
  }
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true
    const ctrl = e.ctrlKey || e.metaKey
    // Ctrl+` belongs to the pane toggle, never to the shell.
    if (ctrl && (e.code === 'Backquote' || e.key === '`')) return false
    if (ctrl && e.shiftKey && e.code === 'KeyC') { copy(); return false }
    if (ctrl && e.code === 'KeyV') { e.preventDefault(); paste(); return false }
    // Ctrl+C copies a selection; with nothing selected it interrupts as usual.
    if (ctrl && !e.shiftKey && e.code === 'KeyC' && term.hasSelection()) { copy(); return false }
    return true
  })
  const links = term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? ''
      const found = [...line.matchAll(URL_RE)].map((m) => ({
        range: { start: { x: m.index! + 1, y }, end: { x: m.index! + m[0].length, y } },
        text: m[0],
        activate: (_e: MouseEvent, url: string) => void api().openExternal(url).catch(() => undefined)
      }))
      callback(found.length ? found : undefined)
    }
  })
  const el = term.element
  const menu = (e: MouseEvent): void => {
    e.preventDefault()
    if (!copy()) paste()
  }
  el?.addEventListener('contextmenu', menu)
  return () => {
    links.dispose()
    el?.removeEventListener('contextmenu', menu)
  }
}