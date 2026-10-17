import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { LoaderCircle, Mic } from 'lucide-react'
import type { VoiceStatus } from '@shared/api'
import { api, errText } from '../store'
import { cx } from '../lib/format'
import { MicBlockedError, record, type Recording } from '../lib/mic'
import { stopSpeaking } from '../lib/voice'
import { Popover } from './Layer'
import { useChatDocument } from './ChatDocument'

const BLOCKED = "Windows blocks the microphone: allow microphone access in Windows' privacy settings."

type Phase = 'idle' | 'starting' | 'listening' | 'working'

/** Every mounted chat box; held F8 records into exactly one of them (pickF8). */
interface Target { box: RefObject<HTMLElement | null>; used: number }
const targets = new Set<Target>()

/** The chat box F8 talks into: a visible one in the window that has the key, the focused one first, else the last used. */
function pickF8(doc: Document): Target | undefined {
  const shown = [...targets].filter((t) => {
    const el = t.box.current
    return !!el && el.ownerDocument === doc && el.getClientRects().length > 0
  })
  return shown.find((t) => t.box.current!.contains(doc.activeElement)) ?? shown.sort((a, b) => b.used - a.used)[0]
}

/**
 * Voice input for one chat box (docs/voice.md): the mic button, which is also the only indicator (pressed with a level
 * ring while listening, a spinner while the words are worked out, a progress ring during the one-time download).
 * Click toggles; hold F8 anywhere but the game view to talk; Enter while listening stops. The words land at the caret;
 * nothing is sent until the player sends it.
 */
export function useVoiceInput({ box, insert }: { box: RefObject<HTMLElement | null>; insert: (text: string) => void }): {
  button: ReactNode
  error: string
  listening: boolean
  stop: () => void
  clearError: () => void
} {
  const doc = useChatDocument()
  const [phase, setPhase] = useState<Phase>('idle')
  const [level, setLevel] = useState(0)
  const [error, setError] = useState('')
  const [consent, setConsent] = useState<VoiceStatus | null>(null)
  const [download, setDownload] = useState<{ received: number; total: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const recording = useRef<Recording | null>(null)
  // A stop that came while the mic was still opening (a quick F8 tap).
  const stopEarly = useRef(false)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const insertRef = useRef(insert)
  insertRef.current = insert
  const target = useRef<Target>({ box, used: 0 })
  // F8 is down for this chat box (kept across renders: the key-up may come after several).
  const held = useRef(false)

  useEffect(() => {
    const t = target.current
    targets.add(t)
    return () => { targets.delete(t); recording.current?.cancel(); recording.current = null }
  }, [])

  useEffect(() => window.genio?.on?.((e) => {
    if (e.type !== 'voice-install') return
    setDownload(e.state === 'downloading' ? { received: e.received, total: e.total } : null)
    if (e.error) setError(`Speech model download failed: ${e.error}`)
  }), [])

  const finish = async (): Promise<void> => {
    const r = recording.current
    recording.current = null
    if (!r) return
    const audio = r.stop()
    setLevel(0)
    setPhase('working')
    try {
      const text = await api().voiceTranscribe(audio)
      if (text) insertRef.current(text)
      else setError('No speech heard.')
    } catch (e) {
      setError(`Voice input failed: ${errText(e)}`)
    } finally {
      setPhase('idle')
    }
  }

  const start = async (): Promise<void> => {
    if (phaseRef.current !== 'idle' || download) return
    target.current.used = Date.now()
    stopSpeaking()
    setError('')
    setConsent(null)
    stopEarly.current = false
    setPhase('starting')
    try {
      const status = await api().voiceStatus()
      if (status.state !== 'ready') {
        setPhase('idle')
        if (status.state === 'missing') setConsent(status)
        else setDownload({ received: status.received, total: status.total })
        return
      }
      if (status.mic === 'denied' || status.mic === 'restricted') throw new MicBlockedError('microphone blocked')
      recording.current = await record({ onLevel: setLevel, onLimit: () => void finish() })
      setPhase('listening')
      if (stopEarly.current) void finish()
    } catch (e) {
      recording.current = null
      setPhase('idle')
      setError(e instanceof MicBlockedError ? BLOCKED : `Voice input failed: ${errText(e)}`)
    }
  }

  const stop = (): void => {
    if (phaseRef.current === 'starting') stopEarly.current = true
    else if (phaseRef.current === 'listening') void finish()
  }

  // Hold F8 to talk, in the window this chat box is in; never while the game view has the keys.
  useEffect(() => {
    const win = doc.defaultView
    if (!win) return
    const inGame = (e: KeyboardEvent): boolean => !!(e.target as Element | null)?.closest?.('.play-live') || !!doc.activeElement?.closest('.play-live')
    const down = (e: KeyboardEvent): void => {
      if (e.key !== 'F8' || inGame(e) || pickF8(doc) !== target.current) return
      e.preventDefault()
      if (e.repeat || held.current) return
      held.current = true
      void start()
    }
    const up = (e: KeyboardEvent): void => {
      if (e.key !== 'F8' || !held.current) return
      held.current = false
      e.preventDefault()
      stop()
    }
    win.addEventListener('keydown', down)
    win.addEventListener('keyup', up)
    return () => { win.removeEventListener('keydown', down); win.removeEventListener('keyup', up) }
  })

  const accept = async (): Promise<void> => {
    const status = consent
    setConsent(null)
    if (status) setDownload({ received: status.received, total: status.total })
    try {
      await api().voiceInstall()
    } catch {
      /* the 'voice-install' event carries the reason */
    } finally {
      setDownload(null)
    }
  }

  const progress = download && download.total ? download.received / download.total : 0
  const node = <>
    <button ref={button} type="button" aria-label={phase === 'listening' ? 'Stop listening' : 'Talk'} aria-pressed={phase === 'listening'}
      title={phase === 'listening' ? 'Stop (Enter)' : 'Talk (click, or hold F8)'}
      className={cx('btn ghost icon composer-mic', phase === 'listening' && 'on', download && 'loading')}
      style={{ '--level': level, '--progress': progress } as CSSProperties}
      disabled={phase === 'working' || phase === 'starting'}
      onClick={() => (phase === 'listening' ? stop() : void start())}>
      {phase === 'working' ? <LoaderCircle size={15} className="spin" /> : <Mic size={15} />}
    </button>
    {consent && (
      <Popover anchor={button} placement="bottom-end" className="voice-consent panel" onClose={() => setConsent(null)} role="dialog" aria-label="Voice input">
        <p>Voice input types what you say into the chat box. It needs a speech model, a one-time {Math.round(consent.total / 1e6)} MB download.
          It runs on this PC: your voice never leaves it.</p>
        <div className="voice-consent-actions">
          <button type="button" className="btn ghost sm" onClick={() => setConsent(null)}>Not now</button>
          <button type="button" className="btn solid sm" onClick={() => void accept()}>Download</button>
        </div>
      </Popover>
    )}
  </>
  return { button: node, error, listening: phase === 'listening', stop, clearError: () => setError('') }
}
