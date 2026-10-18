import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Popover } from './Layer'
import './Picker.css'

/** One choice: a short name in the list, a few sentences below it, and why it cannot be chosen when it cannot. */
export type PickerOption<T extends string> = { value: T; label: string; description: string; unavailable?: string }

/**
 * A drop-down of names with the description of the chosen one below it. While the list is open the line
 * describes the hovered or focused option instead; an option that cannot be chosen is grey, says why, and
 * neither a click nor Enter picks it. `hint` replaces the description (for a picker that is off as a whole).
 */
export function Picker<T extends string>({ label, value, options, onChange, disabled, hint }: {
  label: string
  value: T
  options: PickerOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
  hint?: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState<T>()
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const descId = useId()
  const selected = options.find(o => o.value === value)
  const shown = (open && options.find(o => o.value === active)) || selected
  const dismiss = (): void => { setOpen(false); setActive(undefined) }
  const close = (): void => { dismiss(); trigger.current?.focus() }
  const choose = (o: PickerOption<T>): void => {
    if (o.unavailable) return
    if (o.value !== value) onChange(o.value)
    close()
  }
  useEffect(() => {
    if (open) (panel.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? panel.current?.querySelector<HTMLElement>('[role="option"]'))?.focus()
  }, [open])
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Tab') { e.preventDefault(); close(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    const rows = [...panel.current!.querySelectorAll<HTMLElement>('[role="option"]')]
    const at = rows.indexOf(e.target as HTMLElement)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : (at + (e.key === 'ArrowUp' ? -1 : 1) + rows.length) % rows.length
    rows[next]?.focus()
  }
  const text = hint ?? (shown?.unavailable || shown?.description)
  // The list opens below the description line, so the line stays readable while it follows the hovered option.
  return <div ref={wrap} className="picker-wrap">
    <button ref={trigger} type="button" className="select picker" aria-label={label} aria-haspopup="listbox" aria-expanded={open}
      aria-describedby={text ? descId : undefined} disabled={disabled} onClick={() => (open ? close() : setOpen(true))}>
      <span className="picker-value">{selected?.label}</span><span aria-hidden="true">&#9662;</span>
    </button>
    {open && (
      <Popover anchor={wrap} panel={panel} className="picker-list" role="listbox" aria-label={label}
        style={{ minWidth: trigger.current?.offsetWidth }} onKeyDown={onKey} onClose={(how) => (how === 'escape' ? close() : dismiss())}>
        {options.map(o => (
          <button key={o.value} type="button" role="option" className={o.value === active ? 'picker-row on' : 'picker-row'} aria-selected={o.value === value} aria-disabled={!!o.unavailable}
            onMouseEnter={(e) => { setActive(o.value); e.currentTarget.focus() }} onFocus={() => setActive(o.value)} onClick={() => choose(o)}>
            {o.label}
          </button>
        ))}
      </Popover>
    )}
    {text && <span id={descId} className="field-hint picker-desc">{text}</span>}
  </div>
}
