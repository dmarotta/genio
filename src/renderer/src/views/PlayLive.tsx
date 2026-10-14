import { useEffect, useRef, useState } from 'react'
import { Lock, Maximize } from 'lucide-react'
import type { PlayInput } from '@shared/play'

// A stop scheduled by an unmount, per project: a remount right after it (React StrictMode in development) cancels it.
const leaving = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * The player instance's live Game view: one JPEG frame per credit over the MessagePort main transfers, drawn on a
 * canvas; keyboard, mouse and gamepad state goes back while the canvas has focus. Restored from the removed Play
 * screen (4d08711^) on the player instance's stream. Unmounting closes the port; unless main closed it first (Stop,
 * a new Play), that also stops Play and starts the idle timer.
 */
export function PlayLive({ world, width, height, input, onClosed }: { world: string; width: number; height: number; input: boolean; onClosed: (message: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const port = useRef<MessagePort | undefined>(undefined)
  const keys = useRef(new Set<string>())
  const pointer = useRef({ x: 0.5, y: 0.5, buttons: 0 })
  const enabled = useRef(input)
  const [received, setReceived] = useState(false)
  const [stalled, setStalled] = useState(false)
  const release = (): void => {
    keys.current.clear(); pointer.current.buttons = 0
    port.current?.postMessage({ type: 'input', input: { type: 'release' } })
  }
  useEffect(() => { enabled.current = input; if (!input) release() }, [input])
  useEffect(() => {
    clearTimeout(leaving.get(world)); leaving.delete(world)
    let closed = false, decoding = false, ended = false
    let deadline: ReturnType<typeof setTimeout>
    const end = (message: string): void => { if (!closed && !ended) { ended = true; onClosed(message) } }
    const connect = (event: MessageEvent): void => {
      if (event.source !== window || event.data?.type !== 'genio:play-port' || event.data.world !== world || !event.ports[0]) return
      const channel = event.ports[0]
      if (closed) { channel.close(); return }
      port.current?.close(); port.current = channel
      channel.onmessage = async ({ data }) => {
        // Main closed the stream (Stop, a new Play, or the stream dropped): nothing to stop from here.
        if (data?.type === 'closed') { if (port.current === channel) port.current = undefined; channel.close(); end('The live stream ended.'); return }
        if (closed || decoding || data?.type !== 'frame' || !(data.bytes instanceof Uint8Array)) return
        decoding = true
        try {
          const bitmap = await createImageBitmap(new Blob([new Uint8Array(data.bytes).buffer], { type: 'image/jpeg' }))
          try { if (!closed && canvas.current) { canvas.current.getContext('2d')?.drawImage(bitmap, 0, 0, width, height); setReceived(true); setStalled(false); clearTimeout(deadline) } }
          finally { bitmap.close() }
        } catch { end('Could not decode the Unity stream.') }
        finally { decoding = false; if (!closed && port.current === channel) channel.postMessage({ type: 'ready' }) }
      }
      channel.start(); channel.postMessage({ type: 'ready' })
    }
    const blur = (): void => { release(); if (document.pointerLockElement === canvas.current) void document.exitPointerLock() }
    window.addEventListener('message', connect); window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', blur)
    deadline = setTimeout(() => setStalled(true), 15000)
    void window.genio.api.playerInstanceStream(world, true, width, height).catch(e => end(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
    const timer = setInterval(() => {
      if (!enabled.current || document.hidden || document.activeElement !== canvas.current || !port.current) return
      const pad = navigator.getGamepads?.()[0]
      const indices = [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15]
      const state: PlayInput = { type: 'state', keys: [...keys.current], ...pointer.current,
        axes: [0, 1, 2, 3].map(i => Math.max(-1, Math.min(1, pad?.axes[i] ?? 0))).concat([pad?.buttons[6]?.value ?? 0, pad?.buttons[7]?.value ?? 0]),
        gamepadButtons: indices.reduce((mask, index, i) => mask | (pad?.buttons[index]?.pressed ? 1 << i : 0), 0) }
      port.current.postMessage({ type: 'input', input: state })
    }, 33)
    return () => {
      closed = true; clearTimeout(deadline); clearInterval(timer); release()
      const open = port.current
      port.current = undefined
      window.removeEventListener('message', connect); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', blur)
      if (open) { open.postMessage({ type: 'close' }); open.close() }
      // Leaving while the stream is ours stops Play (and starts the idle timer); after main closed it, nothing to do.
      if (open || !ended) leaving.set(world, setTimeout(() => { leaving.delete(world); void window.genio.api.playerInstanceStream(world, false).catch(() => {}) }, 0))
    }
  }, [world, width, height])
  const key = (code: string): string => code.startsWith('Key') ? code.slice(3) : ({ ArrowLeft: 'LeftArrow', ArrowRight: 'RightArrow', ArrowUp: 'UpArrow', ArrowDown: 'DownArrow', ControlLeft: 'LeftCtrl', ControlRight: 'RightCtrl', ShiftLeft: 'LeftShift', ShiftRight: 'RightShift', AltLeft: 'LeftAlt', AltRight: 'RightAlt' } as Record<string, string>)[code] ?? code
  return <div className="play-live">
    <div className="play-canvas-wrap">
      <canvas ref={canvas} width={width} height={height} tabIndex={0} aria-label="Live Unity Game view"
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
      {!received && <span className="play-canvas-note">{stalled ? 'No frames yet. Unity may be busy; check the console below.' : 'Connecting the live stream…'}</span>}
    </div>
    <div className="play-live-bar">
      <span className="mute">{input ? 'Click the game to control it · Esc releases' : 'View only'}</span>
      <button className="btn sm ghost" disabled={!input} onClick={() => { canvas.current?.focus(); void canvas.current?.requestPointerLock() }}><Lock size={13} /> Lock pointer</button>
      <button className="btn sm ghost" onClick={() => { if (canvas.current) void canvas.current.requestFullscreen().then(() => window.genio.api.featureUsed('play-fullscreen')).catch(() => {}) }}><Maximize size={13} /> Full screen</button>
    </div>
  </div>
}
