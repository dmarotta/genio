import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { PROJECT_WKSP, PROJECT_WINDOW, getState, saveSettings, setState, useStore, type State } from '../store'
import { sendAskGenio } from '../lib/ask-genio'

const LIFETIME = 20_000
const FADE = 200

/** Lives inside the stage shell, so opening the terminal moves the tip above it. */
export function TipCard() {
  const tip = useStore(s => s.tip)
  return PROJECT_WINDOW && tip ? <ActiveTipCard key={`${tip.id}:${tip.shownAt}`} tip={tip} /> : null
}

function ActiveTipCard({ tip }: { tip: NonNullable<State['tip']> }) {
  const card = useRef<HTMLDivElement>(null)
  const sending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [fading, setFading] = useState(false)
  const [position, setPosition] = useState({ bottom: 16, visible: false })
  const dismiss = (): void => setState(s => s.tip === tip ? { tip: undefined } : {})

  useEffect(() => {
    const remaining = Math.max(0, LIFETIME - (Date.now() - tip.shownAt))
    const fade = setTimeout(() => setFading(true), remaining)
    const gone = setTimeout(dismiss, remaining + FADE)
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') dismiss() }
    window.addEventListener('keydown', onKey)
    return () => { clearTimeout(fade); clearTimeout(gone); window.removeEventListener('keydown', onKey) }
  }, [tip])

  // Keep the lower-left corner when it fits. Short windows yield to choices and toasts:
  // move above a colliding toast, or hide if no clear space remains; never queue a later tip.
  useLayoutEffect(() => {
    const el = card.current!
    const shell = el.parentElement!
    let frame = 0
    const fit = (): void => {
      const bounds = shell.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      const gap = window.innerWidth <= 780 ? 8 : 16
      const left = bounds.left + gap
      let bottom = bounds.bottom - gap
      const blockers = [...document.querySelectorAll('.answers-float, .toasts, [data-quota-protection]')]
        .map(n => n.getBoundingClientRect()).filter(b => b.width && b.height)
        .sort((a, b) => b.bottom - a.bottom)
      for (const b of blockers) {
        if (left < b.right + gap && left + r.width > b.left - gap && bottom > b.top - gap && bottom - r.height < b.bottom + gap) bottom = b.top - gap
      }
      const next = { bottom: bounds.bottom - bottom, visible: r.height > 0 && bottom - r.height >= bounds.top + gap && left + r.width <= bounds.right - gap + 1 }
      setPosition(p => p.bottom === next.bottom && p.visible === next.visible ? p : next)
    }
    const schedule = (): void => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit) }
    const resize = new ResizeObserver(schedule)
    const observe = (): void => {
      resize.disconnect()
      for (const n of [shell, el, ...document.querySelectorAll('.answers-float, .toasts, [data-quota-protection]')]) resize.observe(n)
      fit()
      schedule()
    }
    const mutations = new MutationObserver(records => {
      if (records.some(r => !el.contains(r.target))) observe()
    })
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
    observe()
    fit()
    window.addEventListener('resize', schedule)
    document.addEventListener('animationend', schedule)
    document.addEventListener('transitionend', schedule)
    return () => {
      cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect()
      window.removeEventListener('resize', schedule)
      document.removeEventListener('animationend', schedule)
      document.removeEventListener('transitionend', schedule)
    }
  }, [])

  const ask = async (): Promise<void> => {
    if (sending.current) return
    const s = getState()
    const wksp = PROJECT_WKSP ?? s.snap.allies.find(a => !a.retiredAt && a.projects.includes(PROJECT_WINDOW!))?.name
    if (!wksp) return
    sending.current = true
    setBusy(true)
    if (await sendAskGenio(tip.question, wksp, PROJECT_WINDOW)) dismiss()
    else { sending.current = false; setBusy(false) }
  }

  return (
    <div ref={card} className={`tip-card${fading ? ' out' : ''}`} role="status" aria-label="Feature tip"
      style={{ bottom: position.bottom, visibility: position.visible ? 'visible' : 'hidden' }}>
      <div className="tip-line">{tip.line}</div>
      <button className="btn sm ghost icon tip-close" aria-label="Dismiss tip" onClick={dismiss}><X size={14} /></button>
      <div className="tip-actions">
        <button className="btn sm" disabled={busy} onClick={() => void ask()}>Ask Genio</button>
        <button className="btn sm ghost" onClick={() => { dismiss(); void saveSettings({ featureTips: false }) }}>No more tips</button>
      </div>
    </div>
  )
}
