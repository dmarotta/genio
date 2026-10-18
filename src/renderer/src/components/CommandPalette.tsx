import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { PROJECT_WORKSPACE, answerNext, api, focusTask, getState, go, op, openDeploy, playAvailable, setState, useStore, type ViewId } from '../store'
import { navFor, useNav } from './Rail'
import { isSettingsShortcut, openSettings } from '../lib/settings-nav'
import { SETTINGS_INDEX } from '@shared/settings-index'
import { SETTINGS_GROUP_LABEL, settingsPage } from '@shared/settings-pages'
import { KIND_LABEL } from '../lib/vocab'
import { cx } from '../lib/format'
import { Dialog } from './Layer'

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

  // Built while the palette is open only: unit changes arrive all the time and a closed palette shows none of it.
  const cmds = useMemo<Cmd[]>(() => {
    if (!open) return []
    const close = (): void => setState({ palette: false })
    const list: Cmd[] = [
      { id: 'deploy', label: 'Deploy a unit', hint: 'New Build or Recon mission', group: 'Action', run: () => openDeploy() },
      { id: 'answer-next', label: 'Answer next', hint: 'Ctrl J · focus the next pending choice', group: 'Action', run: () => { close(); answerNext() } },
      { id: 'recap', label: '/recap', hint: 'Previously on… and your pending moves', group: 'Action', run: () => { close(); go('comms'); void op('Recap', () => api().recap()) } },
      { id: 'status', label: '/status', hint: 'Character Sheet', group: 'Action', run: () => go('status') },
      { id: 'save', label: '/save', hint: 'Curate player profile & squad memory', group: 'Action', run: () => { close(); void op('Save', () => api().save(), () => 'Genio is curating memory') } },
      { id: 'memory', label: 'Go to Memory', hint: 'Settings · player profile, squad memory, archive', group: 'Navigate', run: () => openSettings('memory') },
      { id: 'mail', label: 'Go to Mail', hint: 'Settings · Inbox & automation · notes for Genio', group: 'Navigate', run: () => openSettings('inbox') },
      { id: 'online', label: 'Presence: Online', group: 'Presence', run: () => { close(); void op('Presence', () => api().setAway('online'), () => 'Online') } },
      { id: 'dnd', label: 'Presence: DND', group: 'Presence', run: () => { close(); void op('Presence', () => api().setAway('dnd'), () => 'Do not disturb') } },
      { id: 'afk', label: 'Presence: AFK', group: 'Presence', run: () => { close(); void op('Presence', () => api().setAway('afk'), () => 'AFK — the Bot has the controls') } },
      ...nav.map((n) => ({ id: `nav-${n.id}`, label: `Go to ${n.label}`, hint: n.key ? `Ctrl ${n.key}` : undefined, group: 'Navigate', run: () => go(n.id as ViewId) })),
      ...tasks
        .filter((t) => t.state !== 'cleaned')
        .map((t) => ({ id: `task-${t.id}`, label: `Unit: ${t.title}`, hint: `${KIND_LABEL[t.kind]} · ${t.project}`, group: 'Squad', run: () => focusTask(t.id) })),
      // Every Settings page and row from the search index, old names included in the hint.
      ...SETTINGS_INDEX.map((e) => {
        const page = settingsPage(e.page)
        const where = page.group === 'project' ? 'This project' : SETTINGS_GROUP_LABEL[page.group]
        return {
          id: `settings-${e.page}-${e.anchor ?? ''}`,
          label: e.anchor ? `Setting: ${e.label}` : `Settings: ${where} › ${page.label}`,
          hint: [e.anchor ? `${where} › ${page.label}` : '', ...(e.synonyms ?? [])].filter(Boolean).join(' · '),
          group: 'Settings',
          run: () => openSettings(e.page, e.anchor)
        }
      })
    ]
    return PROJECT_WORKSPACE ? list : list.filter(c => !['recap', 'save'].includes(c.id))
  }, [open, tasks, nav])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    // Settings rows are many: they join the list once the player types.
    if (!needle) return cmds.filter((c) => c.group !== 'Settings').slice(0, 40)
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
    <Dialog onClose={() => setState({ palette: false })} label="Command palette">
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
    </Dialog>
  )
}

/** Window shortcuts. Ctrl+, (Settings, last page) works everywhere; the rest only in project windows. */
export function useGlobalKeys(enabled = true): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isSettingsShortcut(e)) {
        e.preventDefault()
        setState({ palette: false })
        openSettings()
        return
      }
      if (!enabled || !(e.ctrlKey || e.metaKey)) return
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
