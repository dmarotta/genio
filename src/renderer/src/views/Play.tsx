import { useEffect, useRef, useState } from 'react'
import { PROJECT_WINDOW, PROJECT_WKSP } from '../store'
import { ChatPanel } from './Comms'
import { snapshotDelay, type PlayAction, type PlayConsole, type PlayFrame, type PlayScene, type PlayStats, type PlayStatus } from '@shared/play'
import '../styles/play.css'

const presets = [[1280,720], [640,360], [1920,1080], [1024,768], [720,1280]]
export function Play() {
  const api = window.genio.api
  const world = PROJECT_WINDOW
  const [status, setStatus] = useState<PlayStatus>()
  const [scenes, setScenes] = useState<PlayScene[]>([])
  const [frame, setFrame] = useState<PlayFrame>()
  const [stats, setStats] = useState<PlayStats>()
  const [logs, setLogs] = useState<PlayConsole['entries']>([])
  const [error, setError] = useState('')
  const [size, setSize] = useState(0)
  const [input, setInput] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState('')
  const [chat, setChat] = useState(false)
  const working = useRef(false)
  const refresh = useRef(true)
  useEffect(() => {
    if (!world) return
    let closed = false; let timer: ReturnType<typeof setTimeout>; let failures = 0; let round = 0
    let cursor: number | undefined; let session: string | undefined; let observed: PlayStatus | undefined
    setFrame(undefined); setStatus(undefined); setLogs([]); setScenes([]); setInput(false); setError(''); setSaved('')
    async function poll() {
      const begin = performance.now()
      try {
        if (!working.current && !document.hidden) {
          const s = refresh.current || !observed?.connected || round % 5 === 0 ? await api.playStatus(world!) : observed
          refresh.current = false
          observed = s
          if (closed) return
          setStatus(s)
          if (s.connected) {
            const f = await api.playFrame(world!, ...presets[size] as [number, number])
            if (closed) return
            setFrame(f)
            if (round++ % 5 === 0) {
              const p = await api.playStats(world!)
              const l = await api.playConsole(world!, cursor, session)
              const sceneList = round === 1 ? await api.playScenes(world!) : undefined
              if (closed) return
              cursor = l.cursor; session = l.session
              setStats(p); setLogs(old => [...(l.reset ? [] : old), ...l.entries].slice(-200)); if (sceneList) setScenes(sceneList)
            }
            setError(''); failures = 0
          } else { setFrame(undefined); setInput(false); failures++ }
        }
      } catch (e) { if (!closed) { observed = undefined; setFrame(undefined); setInput(false); setError(String(e)); failures++ } }
      if (!closed) timer = setTimeout(poll, snapshotDelay(performance.now()-begin, failures))
    }
    void poll()
    return () => { closed = true; clearTimeout(timer) }
  }, [world, size])
  async function run(fn: () => Promise<unknown>) {
    if (working.current) return
    working.current = true; setBusy(true)
    try { await fn(); setError('') } catch (e) { setError(String(e)) }
    finally { refresh.current = true; working.current = false; setBusy(false) }
  }
  const act = (action: PlayAction) => void run(() => api.playAction(world!, action))
  if (!world) return <section className="play-view"><h1>Play</h1><p>Open Play from a project window.</p></section>
  const playing = status?.state === 'playing'
  const cpu = stats?.frameTiming?.available ? stats.frameTiming.cpuFrameTimeMs : undefined
  return <section className="play-view">
    <header><h1 className="title">Play <span className="dim">· {world}</span></h1><span>Snapshot mode · about 1 fps · shared control</span><button className="btn" onClick={() => setChat(!chat)}>{chat ? 'Close chat' : 'Ask Genio'}</button></header>
    <div className="play-toolbar">
      <label>Scene <select disabled={busy || !status?.connected || status.state !== 'stopped'} value={status?.scenes.find(s => s.isActive)?.path ?? ''} onChange={e => act({ type: 'scene', path: e.target.value })}>
        <option value="" disabled>Current editor scene</option>{scenes.map(s => <option key={s.path} value={s.path}>{s.name}{s.isDirty ? ' *' : ''} — {s.path}</option>)}
      </select></label>
      <label>Snapshot size <select value={size} onChange={e => setSize(Number(e.target.value))}>{presets.map(([w,h], i) => <option key={i} value={i}>{w} × {h}</option>)}</select></label>
      <button className="btn solid" disabled={busy || !status?.connected || status.state !== 'stopped'} onClick={() => act({ type:'play' })}>Play</button>
      <button className="btn" disabled={busy || !status?.connected || !['playing','paused'].includes(status.state)} onClick={() => act({ type:'pause' })}>{status?.state === 'paused' ? 'Resume' : 'Pause'}</button>
      <button className="btn" disabled={busy || !status?.connected || status.state === 'stopped'} onClick={() => act({ type:'stop' })}>Stop</button>
      <button className="btn" disabled={busy || !frame} onClick={() => void run(async () => setSaved(await api.playScreenshot(world)))}>Screenshot</button>
      <label><input type="checkbox" checked={input} disabled={!playing || !status?.capabilities.input} onChange={e => setInput(e.target.checked)} />Forward clicks and keys</label>
    </div>
    <p className="dim">{status?.state ?? 'Connecting…'} · {playing && stats?.fps ? `${stats.fps.toFixed(1)} game fps` : 'Game FPS unavailable'} · {cpu !== undefined ? `${cpu.toFixed(1)} ms CPU` : 'CPU timing unavailable'} · {stats?.render?.drawCalls ?? '—'} draw calls · {stats?.render?.triangles ?? '—'} triangles · {stats?.memory ? `${(stats.memory.totalAllocatedBytes/1048576).toFixed(0)} MB` : '—'} · capture {frame ? `${frame.latencyMs} ms` : '—'}</p>
    <p className="dim">Presets resize snapshots; Pipeline cannot change the game aspect. Input is discrete and delayed. Click the image to focus keyboard input; Escape releases it.</p>
    {status?.connected && !status.capabilities.input && <p>Legacy input is view-only. Use Unity for hands-on play.</p>}
    {status?.genioDriving && <p>Genio driving <button onClick={() => act({type:'stop'})}>Stop</button></p>}
    {error && <p role="alert">{error}</p>}
    {saved && <p>Saved screenshot <button onClick={() => void api.openPath(saved)}>Open</button></p>}
    {!status?.connected && <div><p>{status?.message}</p><button className="btn" disabled={busy} onClick={() => void run(() => api.playOpenUnity(world))}>Open in Unity</button></div>}
    <div className="play-screen">
      {frame ? <img src={`data:image/png;base64,${frame.base64}`} alt={`Game snapshot from ${frame.capturedAt}`} tabIndex={input ? 0 : -1}
        onClick={e => { if (!input || !playing) return; e.currentTarget.focus(); const r = e.currentTarget.getBoundingClientRect(); act({type:'pointer', x:(e.clientX-r.left)/r.width, y:(e.clientY-r.top)/r.height}) }}
        onKeyDown={e => { if (e.key === 'Escape') { setInput(false); return }; if (!input || !playing || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
          const key = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code : ({ArrowLeft:'LeftArrow',ArrowRight:'RightArrow',ArrowUp:'UpArrow',ArrowDown:'DownArrow'}[e.code] ?? e.code)
          e.preventDefault(); act({type:'key',key}) }} /> : <span className="dim">Waiting for a Game view snapshot</span>}
    </div>
    <details className="play-console" open><summary>Unity console · latest {logs.length} entries</summary><div>{logs.map((l,i) => <pre key={`${l.seq}-${i}`}>[{l.level ?? 'log'}] {l.message}{l.stackTrace ? `\n${l.stackTrace}` : ''}</pre>)}</div></details>
    {chat && PROJECT_WKSP && <aside className="play-chat panel"><ChatPanel wksp={PROJECT_WKSP} /></aside>}
  </section>
}
