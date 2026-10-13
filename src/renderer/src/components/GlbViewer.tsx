import { useEffect, useRef, useState } from 'react'
import { Crosshair, Pause, Play } from 'lucide-react'
import { parseGlb, startGlbRenderer, type GlbClip, type GlbPlayback } from '../lib/glb'
import { errText } from '../store'
import { cx } from '../lib/format'

const SPEEDS = [0.25, 0.5, 1, 1.5, 2]

/**
 * Orbitable preview of a .glb; on anything it can't draw, says why and lets the caller offer "open file".
 * Animated files play, with play/pause, a scrubber, speed, clip choice and a follow camera.
 */
export function GlbViewer({ url, className }: { url: string; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<{ error?: string; info?: string }>({})
  const [clips, setClips] = useState<GlbClip[]>([])
  const pb = useRef<GlbPlayback>({ playing: true, time: 0, speed: 1, clip: 0, follow: true })
  const [ui, setUi] = useState<GlbPlayback>(pb.current)
  const change = (patch: Partial<GlbPlayback>): void => {
    Object.assign(pb.current, patch)
    setUi({ ...pb.current })
  }

  useEffect(() => {
    let dispose: (() => void) | undefined
    let alive = true
    setState({})
    setClips([])
    pb.current = { ...pb.current, time: 0, clip: 0 }
    void (async () => {
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`could not load the file (${res.status})`)
        const model = await parseGlb(await res.arrayBuffer())
        if (!alive || !canvas.current) return
        const list = model.rig?.clips.some((c) => c.duration > 0) ? model.rig.clips : []
        dispose = startGlbRenderer(canvas.current, model, list.length ? pb.current : undefined)
        setClips(list)
        const skeleton = model.prims.some((p) => p.bones)
        const what = skeleton ? `${model.prims[0].bones!.length} bones (no mesh)` : `${Math.round(model.triangles).toLocaleString()} tris · ${model.prims.length} part${model.prims.length === 1 ? '' : 's'}`
        setState({ info: list.length ? `${what} · ${model.rig!.skins[0]?.joints.length ?? model.rig!.nodes.length} joints` : what })
      } catch (e) {
        if (alive) setState({ error: errText(e) })
      }
    })()
    return () => {
      alive = false
      dispose?.()
    }
  }, [url])

  // the renderer advances time; mirror it into the scrubber a few times a second
  useEffect(() => {
    if (!clips.length) return
    const t = setInterval(() => setUi({ ...pb.current }), 100)
    return () => clearInterval(t)
  }, [clips.length])

  const clip = clips[ui.clip] ?? clips[0]
  return (
    <div className={cx('glb-view', clips.length > 0 && 'animated', className)}>
      <canvas ref={canvas} className="glb-canvas" style={state.error ? { display: 'none' } : undefined} />
      {state.error ? (
        <div className="glb-msg mute">No 3D preview: {state.error}</div>
      ) : (
        <div className="glb-hud mono">{state.info ? `${state.info} · drag to orbit · scroll to zoom` : 'loading model…'}</div>
      )}
      {clip && !state.error && (
        <div className="glb-player">
          <button className="btn sm ghost icon" title={ui.playing ? 'Pause' : 'Play'} onClick={() => change({ playing: !ui.playing })}>
            {ui.playing ? <Pause size={13} /> : <Play size={13} />}
          </button>
          <input
            type="range"
            className="glb-scrub"
            min={0}
            max={clip.duration}
            step={0.001}
            value={Math.min(ui.time, clip.duration)}
            onChange={(e) => change({ time: Number(e.target.value), playing: false })}
            aria-label="Time"
          />
          <span className="mono glb-time">
            {ui.time.toFixed(2)} / {clip.duration.toFixed(2)} s
          </span>
          <select className="select compact" value={ui.speed} onChange={(e) => change({ speed: Number(e.target.value) })} title="Playback speed">
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
          {clips.length > 1 && (
            <select className="select compact" value={ui.clip} onChange={(e) => change({ clip: Number(e.target.value), time: 0 })} title="Clip">
              {clips.map((c, i) => (
                <option key={i} value={i}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <button className={cx('btn sm ghost icon', ui.follow && 'on')} title={ui.follow ? 'Camera follows the root (click to let it travel)' : 'Camera fixed (click to follow the root)'} onClick={() => change({ follow: !ui.follow })}>
            <Crosshair size={13} />
          </button>
        </div>
      )}
    </div>
  )
}
