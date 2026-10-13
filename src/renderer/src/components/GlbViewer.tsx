import { useEffect, useRef, useState } from 'react'
import { parseGlb, startGlbRenderer } from '../lib/glb'
import { errText } from '../store'

/** Orbitable preview of a .glb; on anything it can't draw, says why and lets the caller offer "open file". */
export function GlbViewer({ url }: { url: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<{ error?: string; info?: string }>({})
  useEffect(() => {
    let dispose: (() => void) | undefined
    let alive = true
    setState({})
    void (async () => {
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`could not load the file (${res.status})`)
        const model = await parseGlb(await res.arrayBuffer())
        if (!alive || !canvas.current) return
        dispose = startGlbRenderer(canvas.current, model)
        setState({ info: `${Math.round(model.triangles).toLocaleString()} tris · ${model.prims.length} part${model.prims.length === 1 ? '' : 's'}` })
      } catch (e) {
        if (alive) setState({ error: errText(e) })
      }
    })()
    return () => {
      alive = false
      dispose?.()
    }
  }, [url])
  return (
    <div className="glb-view">
      <canvas ref={canvas} className="glb-canvas" style={state.error ? { display: 'none' } : undefined} />
      {state.error ? (
        <div className="glb-msg mute">No 3D preview: {state.error}</div>
      ) : (
        <div className="glb-hud mono">{state.info ? `${state.info} · drag to orbit · scroll to zoom` : 'loading model…'}</div>
      )}
    </div>
  )
}
