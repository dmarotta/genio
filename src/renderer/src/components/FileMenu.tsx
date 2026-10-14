import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ChevronRight } from 'lucide-react'
import { api, op } from '../store'
import { cx } from '../lib/format'
import { fileKeyAction, fileMenu, type FileAction, type FileEntry, type FileItem } from '../lib/filemenu'
import { menuKey } from '../lib/railmenu'
import { readRecent, rememberRecent } from '../lib/recent'
import type { WindowList } from '@shared/api'
import '../styles/filemenu.css'

/** Runs a File menu entry; opening goes through the same projectOpen path as the Hub. */
export async function runFileAction(a: FileAction): Promise<void> {
  const open = async (path: string): Promise<void> => {
    await api().projectOpen(path)
    rememberRecent(path)
  }
  switch (a.type) {
    case 'open-project': await op('Open project', () => open(a.path)); return
    case 'hub': await op('Open Hub', () => api().windowOpenHub()); return
    case 'exit': await op('Exit', () => api().windowClose())
  }
}

/** File menu at the left of the header: Hub, recent projects, and exit this window. */
export function FileMenu() {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<WindowList>({ projects: [], windows: [] })
  const [sel, setSel] = useState(0)
  const [sub, setSub] = useState<number | null>(null)
  const [subSel, setSubSel] = useState(0)
  const wrap = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const items = useRef<(HTMLButtonElement | null)[]>([])
  const subItems = useRef<(HTMLButtonElement | null)[]>([])
  const rows: FileEntry[] = fileMenu(list, open ? readRecent() : [])
  const submenu = sub === null ? undefined : rows[sub]
  const subRows = submenu?.kind === 'submenu' ? submenu.items : []

  const show = (): void => {
    setSel(0); setSub(null); setOpen(true)
    void api().windowList().then(setList).catch(() => undefined)
  }
  const close = (refocus: boolean): void => {
    setOpen(false); setSub(null)
    if (refocus) btn.current?.focus()
  }
  const run = (a: FileAction): void => {
    close(false)
    void runFileAction(a)
  }
  const openSub = (i: number): void => { setSel(i); setSub(i); setSubSel(0) }
  const pick = (i: number): void => {
    const row = rows[i]
    if (row.kind === 'submenu') openSub(i)
    else run(row.action)
  }

  useEffect(() => {
    if (!open) return
    if (sub !== null && subRows.length) subItems.current[subSel]?.focus()
    else items.current[sel]?.focus()
  }, [open, sel, sub, subSel, subRows.length])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => { if (!wrap.current?.contains(e.target as Node)) close(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Window-local accelerators; a focused terminal or field that handled the key keeps it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      const a = fileKeyAction(e)
      if (!a) return
      e.preventDefault()
      close(false)
      void runFileAction(a)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const subKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    e.stopPropagation()
    const a = subRows.length ? menuKey(e.key, subSel, subRows.length) : e.key === 'Escape' || e.key === 'ArrowLeft' ? { type: 'close' as const } : null
    if (!a) return
    e.preventDefault()
    if (a.type === 'move') setSubSel(a.index)
    else if (a.type === 'pick') run(subRows[a.index].action)
    else if (e.key === 'Tab') close(true)
    else setSub(null)
  }

  return (
    <div className="file-menu" ref={wrap}>
      <button
        ref={btn}
        className={cx('file-menu-btn', open && 'open')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(e) => {
          if (!open && e.key === 'ArrowDown') { e.preventDefault(); show() }
        }}
      >
        File
      </button>
      {open && (
        <div className="file-menu-pop">
          <div
            className="file-menu-panel panel glow"
            role="menu"
            aria-label="File"
            onKeyDown={(e) => {
              if (rows[sel]?.kind === 'submenu' && e.key === 'ArrowRight') { e.preventDefault(); openSub(sel); return }
              const a = menuKey(e.key, sel, rows.length)
              if (!a) return
              e.preventDefault()
              e.stopPropagation()
              if (a.type === 'move') { setSel(a.index); setSub(null) }
              else if (a.type === 'pick') pick(a.index)
              else close(e.key !== 'Tab')
            }}
          >
            {rows.map((row, i) => {
              return (
                <button
                  key={row.id}
                  ref={(el) => { items.current[i] = el }}
                  role="menuitem"
                  tabIndex={i === sel ? 0 : -1}
                  aria-haspopup={row.kind === 'submenu' ? 'menu' : undefined}
                  aria-expanded={row.kind === 'submenu' ? sub === i : undefined}
                  className={cx('file-menu-item', i === sel && 'sel')}
                  onMouseEnter={() => (row.kind === 'submenu' ? openSub(i) : (setSel(i), setSub(null)))}
                  onClick={() => pick(i)}
                >
                  <span className="file-menu-label">{row.label}</span>
                  {row.kind === 'submenu' ? <ChevronRight size={14} /> : row.key && <kbd>Ctrl {row.key}</kbd>}
                </button>
              )
            })}
          </div>
          {/* A sibling of the menu, not a child: the panel's chamfer clip-path would cut it off. */}
          {submenu?.kind === 'submenu' && (
            <div
              className="file-menu-panel file-submenu panel glow"
              role="menu"
              aria-label={submenu.label}
              style={{ top: (items.current[sub!]?.offsetTop ?? 0) - 7 }}
              onKeyDown={subKey}
            >
              {subRows.length ? subRows.map((it: FileItem, j) => (
                <button
                  key={it.id}
                  ref={(el) => { subItems.current[j] = el }}
                  role="menuitem"
                  tabIndex={j === subSel ? 0 : -1}
                  title={it.title}
                  className={cx('file-menu-item', j === subSel && 'sel')}
                  onMouseEnter={() => setSubSel(j)}
                  onClick={() => run(it.action)}
                >
                  <span className="file-menu-label">{it.label}</span>
                  {it.hint && <span className="file-menu-hint mute">{it.hint}</span>}
                </button>
              )) : <div className="file-menu-empty mute">{submenu.empty}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
