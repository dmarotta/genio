import { useEffect, useRef } from 'react'
import { Lock, Maximize } from 'lucide-react'
import { PLAY_SCROLL_LIMIT, type PlayInput } from '@shared/play'
import { AUDIO_ACK_EVERY, PLAY_AUDIO_PROCESSOR } from '../lib/play-audio'
import workletUrl from '../lib/play-audio-worklet?worker&url'

/** No packet this long after the live view opens: the game has no AudioListener (or no audio module). */
const NO_SOUND_MS = 3000

/**
 * The game's sound for one live view: an AudioContext and the ring worklet (lib/play-audio.ts), made on the first
 * packet. Browsers start audio only once the page has had a user gesture; pressing Play (or unmuting) is one, and a
 * context that still comes up suspended resumes on the next click or key on the page. Muted: gain 0, suspended, and
 * packets dropped; unmuting flushes what was left so the sound picks up live. Failures stay silent.
 */
function gameSound(initiallyMuted: boolean) {
  let context: AudioContext | undefined, gain: GainNode | undefined, node: AudioWorkletNode | undefined
  let muted = initiallyMuted, closed = false
  const wake = (): void => { if (!closed && !muted && context?.state === 'suspended') void context.resume().catch(() => {}) }
  const start = (): void => {
    try { context = new AudioContext({ latencyHint: 'interactive' }) } catch { closed = true; return }
    const c = context, g = gain = c.createGain()
    g.connect(c.destination)
    void c.audioWorklet.addModule(workletUrl).then(() => {
      if (closed) return
      node = new AudioWorkletNode(c, PLAY_AUDIO_PROCESSOR, { numberOfInputs: 0, outputChannelCount: [2] })
      node.connect(g)
    }).catch(() => {})
    wake()
    window.addEventListener('pointerdown', wake); window.addEventListener('keydown', wake)
  }
  return {
    packet(bytes: Uint8Array): void {
      if (closed || muted) return
      if (!context) start()
      node?.port.postMessage(bytes, [bytes.buffer])
    },
    mute(on: boolean): void {
      if (muted === on) return
      muted = on
      if (!context || !gain) return
      if (on) { gain.gain.value = 0; void context.suspend().catch(() => {}) }
      else { node?.port.postMessage({ type: 'flush' }); gain.gain.value = 1; wake() }
    },
    close(): void {
      closed = true
      window.removeEventListener('pointerdown', wake); window.removeEventListener('keydown', wake)
      void context?.close().catch(() => {})
    }
  }
}

// A stop scheduled by an unmount, per project: a remount right after it (React StrictMode in development) cancels it.
const leaving = new Map<string, ReturnType<typeof setTimeout>>()
const message = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * A wheel event in notches, positive away from the player (Unity's scroll up, the browser's negative deltaY). One notch
 * is about 100 px in Chromium, 3 lines in line mode, and one page when Windows scrolls a screen at a time.
 */
export function wheelNotches(e: Pick<WheelEvent, 'deltaY' | 'deltaMode'>): number {
  const notch = e.deltaMode === 2 ? 1 : e.deltaMode === 1 ? 3 : 100
  return Number.isFinite(e.deltaY) ? -e.deltaY / notch : 0
}

/**
 * The player instance's live Game view: one frame per credit, drawn on a canvas. Frames are JPEGs over the MessagePort
 * main transfers or, on the fast path, GPU frames from the preload (shared textures, drawn as they come with no decode);
 * either way the credit goes back on the port. Keyboard, mouse and gamepad state goes back while the canvas has focus.
 * A new width or height resizes Unity's stream behind the same port, so Play continues. The game's sound plays from the same port unless `muted`;
 * `onSound` says whether any arrived. Unmounting closes the port and the sound; unless main closed the port first
 * (Stop, a new Play), that also exits Play and starts the idle timer.
 */
export function PlayLive({ world, width, height, input, muted = false, onClosed, onError, onSound }: {
  world: string; width: number; height: number; input: boolean; muted?: boolean
  onClosed: (message: string) => void; onError?: (message: string) => void; onSound?: (heard: boolean) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const port = useRef<MessagePort | undefined>(undefined)
  const keys = useRef(new Set<string>())
  const pointer = useRef({ x: 0.5, y: 0.5, buttons: 0 })
  const scroll = useRef(0)
  const enabled = useRef(input)
  const size = useRef({ width, height })
  const mutedNow = useRef(muted)
  const sound = useRef<ReturnType<typeof gameSound> | undefined>(undefined)
  useEffect(() => { mutedNow.current = muted; sound.current?.mute(muted) }, [muted])
  const release = (): void => {
    keys.current.clear(); pointer.current.buttons = 0; scroll.current = 0
    port.current?.postMessage({ type: 'input', input: { type: 'release' } })
  }
  useEffect(() => { enabled.current = input; if (!input) release() }, [input])
  // React's onWheel is passive and cannot stop the page scrolling. While the game has input (the canvas holds focus and
  // Esc has not released it) the wheel goes to Unity, summed until the next state packet; otherwise the page scrolls.
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const wheel = (e: WheelEvent): void => {
      if (!enabled.current || document.activeElement !== c) return
      e.preventDefault()
      scroll.current = Math.max(-PLAY_SCROLL_LIMIT, Math.min(PLAY_SCROLL_LIMIT, scroll.current + wheelNotches(e)))
    }
    c.addEventListener('wheel', wheel, { passive: false })
    return () => c.removeEventListener('wheel', wheel)
  }, [])
  useEffect(() => {
    clearTimeout(leaving.get(world)); leaving.delete(world)
    let closed = false, decoding = false, ended = false, heard = false
    const end = (message: string): void => { if (!closed && !ended) { ended = true; onClosed(message) } }
    const audio = sound.current = gameSound(mutedNow.current)
    const quiet = setTimeout(() => { if (!heard && !closed) onSound?.(false) }, NO_SOUND_MS)
    const connect = (event: MessageEvent): void => {
      if (event.source !== window || event.data?.type !== 'genio:play-port' || event.data.world !== world || !event.ports[0]) return
      const channel = event.ports[0]
      if (closed) { channel.close(); return }
      port.current?.close(); port.current = channel
      let acks = 0
      channel.onmessage = async ({ data }) => {
        // Main closed the stream (Stop, a new Play, or the stream dropped): nothing to stop from here.
        if (data?.type === 'closed') { if (port.current === channel) port.current = undefined; channel.close(); end('The live stream ended.'); return }
        // Sound is acked even while muted, so main keeps sending and unmuting is instant.
        if (data?.type === 'audio') {
          if (closed || port.current !== channel) return
          if (++acks >= AUDIO_ACK_EVERY) { channel.postMessage({ type: 'audio-ack', count: acks, heard: !mutedNow.current }); acks = 0 }
          if (!heard) { heard = true; onSound?.(true) }
          if (data.bytes instanceof Uint8Array) audio.packet(data.bytes)
          return
        }
        if (closed || decoding || data?.type !== 'frame' || !(data.bytes instanceof Uint8Array)) return
        decoding = true
        try {
          const bitmap = await createImageBitmap(new Blob([new Uint8Array(data.bytes).buffer], { type: 'image/jpeg' }))
          try { const c = canvas.current; if (!closed && c) c.getContext('2d')?.drawImage(bitmap, 0, 0, c.width, c.height) }
          finally { bitmap.close() }
        } catch { end('Could not decode the Unity stream.') }
        finally { decoding = false; if (!closed && port.current === channel) channel.postMessage({ type: 'ready' }) }
      }
      channel.start(); channel.postMessage({ type: 'ready' })
    }
    const blur = (): void => { release(); if (document.pointerLockElement === canvas.current) void document.exitPointerLock() }
    const offFrames = window.genio.onPlayFrame?.(world, frame => {
      try { const c = canvas.current; if (!closed && c) c.getContext('2d')?.drawImage(frame, 0, 0, c.width, c.height) }
      finally { if (!closed) port.current?.postMessage({ type: 'ready' }) }
    })
    window.addEventListener('message', connect); window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', blur)
    void window.genio.api.playerInstanceStream(world, true, size.current.width, size.current.height).catch(e => end(message(e)))
    const timer = setInterval(() => {
      if (!enabled.current || document.hidden || document.activeElement !== canvas.current || !port.current) return
      const pad = navigator.getGamepads?.()[0]
      const indices = [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15]
      const state: PlayInput = { type: 'state', keys: [...keys.current], ...pointer.current,
        axes: [0, 1, 2, 3].map(i => Math.max(-1, Math.min(1, pad?.axes[i] ?? 0))).concat([pad?.buttons[6]?.value ?? 0, pad?.buttons[7]?.value ?? 0]),
        gamepadButtons: indices.reduce((mask, index, i) => mask | (pad?.buttons[index]?.pressed ? 1 << i : 0), 0), scroll: scroll.current }
      port.current.postMessage({ type: 'input', input: state })
      scroll.current = 0
    }, 33)
    return () => {
      closed = true; clearInterval(timer); clearTimeout(quiet); release(); offFrames?.()
      audio.close(); if (sound.current === audio) sound.current = undefined
      const open = port.current
      port.current = undefined
      window.removeEventListener('message', connect); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', blur)
      if (open) { open.postMessage({ type: 'close' }); open.close() }
      // Leaving while the stream is ours stops Play (and starts the idle timer); after main closed it, nothing to do.
      if (open || !ended) leaving.set(world, setTimeout(() => { leaving.delete(world); void window.genio.api.playerInstanceStream(world, false).catch(() => {}) }, 0))
    }
  }, [world])
  // A new resolution swaps Unity's stream session behind the same port: no reconnect, Play keeps running.
  useEffect(() => {
    if (size.current.width === width && size.current.height === height) return
    size.current = { width, height }
    void window.genio.api.playerInstanceResize(world, width, height).catch(e => onError?.(message(e)))
  }, [world, width, height])
  const key = (code: string): string => code.startsWith('Key') ? code.slice(3) : ({ ArrowLeft: 'LeftArrow', ArrowRight: 'RightArrow', ArrowUp: 'UpArrow', ArrowDown: 'DownArrow', ControlLeft: 'LeftCtrl', ControlRight: 'RightCtrl', ShiftLeft: 'LeftShift', ShiftRight: 'RightShift', AltLeft: 'LeftAlt', AltRight: 'RightAlt' } as Record<string, string>)[code] ?? code
  return <div className="play-live">
    <div className="play-canvas-wrap">
      <canvas ref={canvas} width={width} height={height} tabIndex={0} aria-label="Live Unity Game view" style={{ aspectRatio: `${width} / ${height}` }}
        onBlur={release} onContextMenu={e => { if (input) e.preventDefault() }}
        onPointerMove={e => {
          const r = e.currentTarget.getBoundingClientRect()
          const locked = document.pointerLockElement === e.currentTarget
          pointer.current.x = Math.max(0, Math.min(1, locked ? pointer.current.x + e.movementX / r.width : (e.clientX - r.left) / r.width))
          pointer.current.y = Math.max(0, Math.min(1, locked ? pointer.current.y + e.movementY / r.height : (e.clientY - r.top) / r.height))
        }}
        onPointerDown={e => { e.currentTarget.focus(); if (!input) return; e.currentTarget.setPointerCapture(e.pointerId); pointer.current.buttons = e.buttons & 7 }}
        onPointerUp={e => { pointer.current.buttons = e.buttons & 7 }} onPointerCancel={release}
        onKeyDown={e => { if (e.key === 'Escape') { enabled.current = false; release(); e.currentTarget.blur(); return }; if (!input || e.metaKey) return; enabled.current = true; e.preventDefault(); if (keys.current.size < 32) keys.current.add(key(e.code)) }}
        onFocus={() => { enabled.current = input }}
        onKeyUp={e => { keys.current.delete(key(e.code)); if (input) e.preventDefault() }} />
    </div>
    {/* Left-aligned: the floating Genio chat sits over the bottom-right corner. */}
    <div className="play-live-bar">
      <button className="btn sm ghost" disabled={!input} title={input ? 'Lock pointer' : 'View only: this game reads legacy input'} aria-label="Lock pointer" onClick={() => { canvas.current?.focus(); void canvas.current?.requestPointerLock() }}><Lock size={13} /></button>
      <button className="btn sm ghost" title="Full screen" aria-label="Full screen" onClick={() => { if (canvas.current) void canvas.current.requestFullscreen().then(() => window.genio.api.featureUsed('play-fullscreen')).catch(() => {}) }}><Maximize size={13} /></button>
    </div>
  </div>
}
