import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api } from '../store'
import { onTerminal } from '../lib/termbus'

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
 * Keyboard input goes straight to the unit: the player may type into any terminal.
 */
export function TerminalView({ id, fontSize = 12, interactive = true, autoFocus = false }: { id: string; fontSize?: number; interactive?: boolean; autoFocus?: boolean }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
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
    term.open(el)
    let disposed = false
    let attached = false
    const pending: string[] = []

    const unsub = onTerminal(id, (data) => {
      if (!attached) pending.push(data)
      else term.write(data)
    })

    const doFit = (): void => {
      if (disposed) return
      try {
        fit.fit()
        void api().terminalResize(id, term.cols, term.rows).catch(() => undefined)
      } catch {
        /* not visible yet */
      }
    }

    void api()
      .terminalAttach(id)
      .then((scroll) => {
        if (disposed) return
        if (scroll) term.write(scroll)
        for (const p of pending) term.write(p)
        pending.length = 0
        attached = true
        requestAnimationFrame(doFit)
        if (autoFocus) term.focus()
      })
      .catch((e) => {
        attached = true
        term.write(`\r\n\x1b[38;2;255;46;110m[no signal] ${String(e?.message ?? e)}\x1b[0m\r\n`)
      })

    const sub = term.onData((d) => {
      if (interactive) void api().terminalWrite(id, d).catch(() => undefined)
    })

    let t: number | undefined
    const ro = new ResizeObserver(() => {
      if (t) window.clearTimeout(t)
      t = window.setTimeout(doFit, 60)
    })
    ro.observe(el)

    return () => {
      disposed = true
      ro.disconnect()
      sub.dispose()
      unsub()
      term.dispose()
    }
  }, [id, fontSize, interactive, autoFocus])

  return <div className="term-host" ref={host} onMouseDown={(e) => e.stopPropagation()} />
}
