import { useEffect, useRef, useState } from 'react'
import type { PlayInput } from '@shared/play'

export function PlayLive({ world, width, height, input, onError }: { world: string; width: number; height: number; input: boolean; onError: (message: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const port = useRef<MessagePort | undefined>(undefined)
  const keys = useRef(new Set<string>())
  const pointer = useRef({ x: 0.5, y: 0.5, buttons: 0 })
  const enabled = useRef(input)
  const [received, setReceived] = useState(false)
  const release = () => {
    keys.current.clear(); pointer.current.buttons = 0
    port.current?.postMessage({ type: 'input', input: { type: 'release' } })
  }
  useEffect(() => { enabled.current = input; if (!input) release() }, [input])
  useEffect(() => {
    let closed = false, decoding = false
    let deadline: ReturnType<typeof setTimeout>
    const fail = (message: string) => { if (!closed) onError(message) }
    const connect = (event: MessageEvent) => {
      if (event.source !== window || event.data?.type !== 'genio:play-port' || event.data.world !== world || !event.ports[0]) return
      const channel = event.ports[0]
      if (closed) { channel.close(); return }
      port.current?.close(); port.current = channel
      channel.onmessage = async ({ data }) => {
        if (data?.type === 'closed') { fail('Live stream disconnected; snapshot mode is available.'); return }
        if (closed || decoding || data?.type !== 'frame' || !(data.bytes instanceof Uint8Array)) return
        decoding = true
        try {
          const bitmap = await createImageBitmap(new Blob([new Uint8Array(data.bytes).buffer], { type: 'image/jpeg' }))
          try { if (!closed && canvas.current) { canvas.current.getContext('2d')?.drawImage(bitmap, 0, 0, width, height); setReceived(true); clearTimeout(deadline) } }
          finally { bitmap.close() }
        } catch { fail('Could not decode the Unity stream') }
        finally { decoding = false; if (!closed) channel.postMessage({ type: 'ready' }) }
      }
      channel.start(); channel.postMessage({ type: 'ready' })
    }
    const blur = () => { release(); if (document.pointerLockElement === canvas.current) void document.exitPointerLock() }
    window.addEventListener('message', connect); window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', blur)
    deadline = setTimeout(() => fail('No live frames arrived. Check the Unity console, then retry live streaming.'), 15000)
    void window.genio.api.playStream(world, true, width, height).catch(e => fail(String(e)))
    const timer = setInterval(() => {
      if (!enabled.current || document.hidden || document.activeElement !== canvas.current || !port.current) return
      const pad = navigator.getGamepads?.()[0]
      const indices = [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15]
      const state: PlayInput = { type: 'state', keys: [...keys.current], ...pointer.current,
        axes: [0,1,2,3].map(i => Math.max(-1, Math.min(1, pad?.axes[i] ?? 0))).concat([pad?.buttons[6]?.value ?? 0, pad?.buttons[7]?.value ?? 0]),
        gamepadButtons: indices.reduce((mask, index, i) => mask | (pad?.buttons[index]?.pressed ? 1 << i : 0), 0) }
      port.current.postMessage({ type: 'input', input: state })
    }, 33)
    return () => {
      closed = true; clearTimeout(deadline); clearInterval(timer); release()
      port.current?.postMessage({ type: 'close' }); port.current?.close(); port.current = undefined
      window.removeEventListener('message', connect); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', blur)
      void window.genio.api.playStream(world, false).catch(() => {})
    }
  }, [world, width, height])
  const key = (code: string) => code.startsWith('Key') ? code.slice(3) : ({ArrowLeft:'LeftArrow',ArrowRight:'RightArrow',ArrowUp:'UpArrow',ArrowDown:'DownArrow',ControlLeft:'LeftCtrl',ControlRight:'RightCtrl',ShiftLeft:'LeftShift',ShiftRight:'RightShift',AltLeft:'LeftAlt',AltRight:'RightAlt'}[code] ?? code)
  return <div className="play-live">
    {!received && <span>Connecting live stream…</span>}
    <canvas ref={canvas} width={width} height={height} tabIndex={input ? 0 : -1} aria-label="Live Unity Game view"
      onBlur={release} onContextMenu={e => { if (input) e.preventDefault() }}
      onPointerMove={e => {
        const r = e.currentTarget.getBoundingClientRect()
        const locked = document.pointerLockElement === e.currentTarget
        pointer.current.x = Math.max(0, Math.min(1, locked ? pointer.current.x + e.movementX / r.width : (e.clientX-r.left)/r.width))
        pointer.current.y = Math.max(0, Math.min(1, locked ? pointer.current.y + e.movementY / r.height : (e.clientY-r.top)/r.height))
      }}
      onPointerDown={e => { if (!input) return; e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId); pointer.current.buttons = e.buttons & 7 }}
      onPointerUp={e => { pointer.current.buttons = e.buttons & 7 }} onPointerCancel={release}
      onKeyDown={e => { if (e.key === 'Escape') { enabled.current = false; release(); e.currentTarget.blur(); return }; if (!input || e.metaKey) return; enabled.current = true; e.preventDefault(); if (keys.current.size < 32) keys.current.add(key(e.code)) }}
      onFocus={() => { enabled.current = input }}
      onKeyUp={e => { keys.current.delete(key(e.code)); if (input) e.preventDefault() }} />
    <button className="btn" disabled={!input} onClick={() => { canvas.current?.focus(); void canvas.current?.requestPointerLock() }}>Lock pointer · Esc releases</button>
    <button className="btn" onClick={() => { if (canvas.current) void canvas.current.requestFullscreen().then(() => window.genio.api.featureUsed('play-fullscreen')).catch(() => {}) }}>Full screen</button>
  </div>
}
