import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { PROJECT_WKSP, api, focusTask, getState, go, op, openDeploy, playAvailable, setState, useStore, type ViewId } from '../store'
import { navFor, useNav } from './Rail'
import { requestSystemsSection } from '../views/Systems'
import { KIND_LABEL } from '../lib/vocab'
import { cx } from '../lib/format'

interface Cmd {
  id: string
  label: string
  hint?: string
  group: string
  run: () => void
}

export function CommandPalette() {
  const open = useStore((s) => s.palette)
  const tasks = useStore((s) => s.snap.tasks)
  const nav = useNav()
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQ('')
      setSel(0)
      setTimeout(() => input.current?.focus(), 10)
    }
  }, [open])

  const cmds = useMemo<Cmd[]>(() => {
    const close = (): void => setState({ palette: false })
    const list: Cmd[] = [
      { id: 'deploy', label: 'Deploy a unit', hint: 'New Build or Recon mission', group: 'Action', run: () => openDeploy() },
      { id: 'recap', label: '/recap', hint: 'Previously on… and your pending moves', group: 'Action', run: () => { close(); go('comms'); void op('Recap', () => api().recap()) } },
      { id: 'status', label: '/status', hint: 'Character Sheet', group: 'Action', run: () => go('status') },
      { id: 'save', label: '/save', hint: 'Curate player profile & squad memory', group: 'Action', run: () => { close(); void op('Save', () => api().save(), () => 'Genio is curating memory') } },
      { id: 'memory', label: 'Go to Memory', hint: 'Settings · player profile, squad memory, archive', group: 'Navigate', run: () => { requestSystemsSection('memory'); go('systems') } },
      { id: 'mail', label: 'Go to Mail', hint: 'Settings · notes for Genio', group: 'Navigate', run: () => { requestSystemsSection('mail'); go('systems') } },
      { id: 'online', label: 'Presence: Online', group: 'Presence', run: () => { close(); void op('Presence', () => api().setAway('online'), () => 'Online') } },
      { id: 'dnd', label: 'Presence: DND', group: 'Presence', run: () => { close(); void op('Presence', () => api().setAway('dnd'), () => 'Do not disturb') } },
      { id: 'afk', label: 'Presence: AFK', group: 'Presence', run: () => { close(); void op('Presence', () => api().setAway('afk'), () => 'AFK — the Bot has the controls') } },
      ...nav.map((n) => ({ id: `nav-${n.id}`, label: `Go to ${n.label}`, hint: n.key ? `Ctrl ${n.key}` : undefined, group: 'Navigate', run: () => go(n.id as ViewId) })),
      ...tasks
        .filter((t) => t.state !== 'cleaned')
        .map((t) => ({ id: `task-${t.id}`, label: `Unit: ${t.title}`, hint: `${KIND_LABEL[t.kind]} · ${t.project}`, group: 'Squad', run: () => focusTask(t.id) }))
    ]
    return PROJECT_WKSP ? list : list.filter(c => !['recap', 'save'].includes(c.id))
  }, [tasks, nav])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return cmds.slice(0, 40)
    return cmds
      .map((c) => {
        const hay = `${c.label} ${c.hint ?? ''} ${c.group}`.toLowerCase()
        let score = hay.indexOf(needle)
        if (score < 0) {
          // subsequence match
          let i = 0
          for (const ch of hay) if (ch === needle[i]) i++
          score = i === needle.length ? 100 : -1
        }
        return { c, score }
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score)
      .map((x) => x.c)
      .slice(0, 40)
  }, [cmds, q])

  if (!open) return null
  const run = (c?: Cmd): void => {
    if (!c) return
    c.run()
    setState({ palette: false })
  }
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && setState({ palette: false })}>
      <div className="palette panel glow ticks rise">
        <div className="palette-input">
          <Search size={16} className="mute" />
          <input
            ref={input}
            value={q}
            placeholder="Type a command, project or unit…"
            onChange={(e) => {
              setQ(e.target.value)
              setSel(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSel((s) => Math.min(filtered.length - 1, s + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((s) => Math.max(0, s - 1))
              } else if (e.key === 'Enter') run(filtered[sel])
              else if (e.key === 'Escape') setState({ palette: false })
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list">
          {filtered.map((c, i) => (
            <button key={c.id} className={cx('palette-item', i === sel && 'on')} onMouseEnter={() => setSel(i)} onClick={() => run(c)}>
              <span className="palette-group label">{c.group}</span>
              <span className="palette-label">{c.label}</span>
              {c.hint && <span className="palette-hint mute">{c.hint}</span>}
            </button>
          ))}
          {!filtered.length && <div className="mute" style={{ padding: 16 }}>No match.</div>}
        </div>
      </div>
    </div>
  )
}

export function useGlobalKeys(enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setState((s) => ({ palette: !s.palette }))
        return
      }
      const item = navFor(playAvailable(getState())).find(n => n.key === e.key)
      if (item && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        go(item.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}
