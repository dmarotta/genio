import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import type { PlayAction, PlayConsole, PlayFrame, PlayScene, PlayStats, PlayStatus } from '@shared/play'

export interface EngineAdapter {
  status(): Promise<PlayStatus>
  scenes(): Promise<PlayScene[]>
  act(action: PlayAction, stillAllowed?: () => boolean): Promise<void>
  frame(width: number, height: number): Promise<PlayFrame>
  console(cursor?: number, session?: string): Promise<PlayConsole>
  stats(): Promise<PlayStats>
  stream?(session?: { port: number; token: string; width: number; height: number }): Promise<void>
}
interface Descriptor { port: number; pid: number; evalToken: string; projectPath: string; lastHeartbeat: string; mode: string; host?: string }
const samePath = (a: string, b: string): boolean => {
  const normalize = (v: string) => process.platform === 'win32' ? path.resolve(v).toLowerCase() : path.resolve(v)
  return normalize(a) === normalize(b)
}

/** The address never comes from metadata or a renderer. Secrets stay inside main. */
export function pipelineRequest(port: number, token: string, command: string, parameters: object = {}): Promise<unknown> {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new Error('Invalid Pipeline credentials')
  return new Promise((resolve, reject) => {
    let deadline: ReturnType<typeof setTimeout> | undefined
    const body = JSON.stringify({ command, parameters, timeout: 15000 })
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/exec', method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)
    } }, res => {
      const chunks: Buffer[] = []; let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 16 * 1024 * 1024) req.destroy(new Error('Pipeline response too large'))
        else chunks.push(chunk)
      })
      res.on('error', () => { clearTimeout(deadline); reject(new Error('Pipeline response interrupted')) })
      res.on('end', () => {
        clearTimeout(deadline)
        if (res.statusCode !== 200) return reject(new Error(`Pipeline HTTP ${res.statusCode}; focus Unity to check its state`))
        try {
          const envelope = JSON.parse(Buffer.concat(chunks).toString())
          if (envelope.success === false) throw new Error('Command refused')
          const result = envelope.result
          if (result?.success === false || result?.status === 'unavailable') throw new Error('Command unavailable')
          if (result === undefined) throw new Error('Missing result')
          resolve(result)
        } catch { reject(new Error(`Unity ${command} failed; check the Unity console`)) }
      })
    })
    req.setTimeout(20000, () => req.destroy(new Error('timeout')))
    deadline = setTimeout(() => req.destroy(new Error('timeout')), 20000)
    req.on('error', () => { clearTimeout(deadline); reject(new Error('Unity is unavailable or waiting on a dialog. Focus Unity.')) })
    req.end(body)
  })
}

export class UnityAdapter implements EngineAdapter {
  private queue: Promise<unknown> = Promise.resolve()
  private pending = 0
  constructor(readonly root: string, private guard: () => Promise<unknown> = async () => {}) {}
  private supportsInput(): boolean {
    try { return !/activeInputHandler:\s*0\b/.test(fs.readFileSync(path.join(this.root, 'ProjectSettings/ProjectSettings.asset'), 'utf8')) }
    catch { return true } // Pipeline returns an explicit unavailable error if no Input System exists.
  }

  private descriptor(): Descriptor {
    let d: Descriptor
    try { d = JSON.parse(fs.readFileSync(path.join(this.root, 'Library/Pipeline/.unity-pipeline-port'), 'utf8')) }
    catch { throw new Error('No connected Unity editor. Open in Unity.') }
    if (!d.projectPath || !samePath(d.projectPath, this.root) || d.mode !== 'editor' || (d.host && d.host !== '127.0.0.1')) throw new Error('Refusing a different, headless or non-local editor')
    const age = Date.now() - Date.parse(d.lastHeartbeat)
    // Pipeline 0.8 writes this timestamp at server startup, not every tick.
    // Prove liveness by PID plus authenticated status instead of expiring a live editor.
    if (!Number.isFinite(age) || age < -30000 || !Number.isInteger(d.pid) || d.pid <= 0) throw new Error('Invalid Unity editor heartbeat')
    try { process.kill(d.pid, 0) } catch { throw new Error('Unity editor has closed') }
    return d
  }
  private identity?: string
  private async call<T>(command: string, parameters: object = {}): Promise<T> {
    await this.guard()
    const d = this.descriptor()
    const identity = `${d.pid}:${d.port}:${d.evalToken}`
    if (identity !== this.identity) {
      const s = await pipelineRequest(d.port, d.evalToken, 'editor_status') as { projectPath?: string }
      if (!s.projectPath || !samePath(s.projectPath, this.root)) throw new Error('Pipeline editor identity does not match this world')
      this.identity = identity
    }
    await this.guard()
    return pipelineRequest(d.port, d.evalToken, command, parameters) as Promise<T>
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pending >= 8) return Promise.reject(new Error('Unity is busy; wait for pending requests'))
    this.pending++
    const next = this.queue.then(fn, fn).finally(() => this.pending--)
    this.queue = next.catch(() => {})
    return next
  }
  async scenes(): Promise<PlayScene[]> {
    return this.serial(async () => (await this.call<{ scenes: PlayScene[] }>('list_open_scenes')).scenes)
  }
  async status(): Promise<PlayStatus> {
    return this.serial(async () => {
      try {
        const s = await this.call<{ playMode: PlayStatus['state']; compiling: boolean; domainReloadInProgress: boolean }>('editor_status')
        const scenes = (await this.call<{ scenes: PlayScene[] }>('list_open_scenes')).scenes
        return { connected: true, state: s.compiling ? 'compiling' : s.domainReloadInProgress ? 'reloading' : s.playMode, scenes, capabilities: { resolution: this.hasPackage(), input: this.supportsInput() } }
      } catch (e) { return { connected: false, state: 'gone', scenes: [], capabilities: { resolution: false, input: false }, message: (e as Error).message } }
    })
  }
  async act(a: PlayAction, stillAllowed: () => boolean = () => true): Promise<void> {
    return this.serial(async () => {
      if (!stillAllowed()) throw new Error('Player took control')
      if (!a || !['play', 'pause', 'stop', 'step', 'scene', 'resolution', 'key', 'pointer'].includes(a.type)) throw new Error('Unknown Play action')
      if (a.type === 'resolution' && !this.hasPackage()) throw new Error('Pipeline does not support Game view resolution. Presets change snapshot size only.')
      const s = await this.call<{ playMode: string; compiling: boolean; domainReloadInProgress: boolean }>('editor_status')
      if (s.compiling || s.domainReloadInProgress) throw new Error('Wait for Unity to finish compiling or reloading')
      if (!stillAllowed()) throw new Error('Player took control')
      if (a.type === 'step') {
        if (s.playMode !== 'paused') throw new Error('Pause Play Mode before stepping')
        await this.call('genio_step'); return
      }
      if (a.type === 'resolution') {
        if (![a.width, a.height].every(n => Number.isInteger(n) && n >= 16 && n <= 3840)) throw new Error('Invalid game resolution')
        await this.call('genio_set_resolution', { width: a.width, height: a.height }); return
      }
      if (a.type === 'play' || a.type === 'scene') {
        const { scenes } = await this.call<{ scenes: PlayScene[] }>('list_open_scenes')
        if (!Array.isArray(scenes) || !scenes.length || scenes.some(s => s.isDirty !== false || !s.path)) throw new Error('Unsaved scenes: save or discard changes in Unity before continuing. Genio never saves scenes.')
        if (!stillAllowed()) throw new Error('Player took control')
      }
      if (a.type === 'scene') {
        if (s.playMode !== 'stopped') throw new Error('Stop Play Mode before opening a scene')
        if (!/^Assets\/.+\.unity$/.test(a.path) || a.path.split('/').includes('..') || a.path.includes('\\')) throw new Error('Invalid scene path')
        await this.call('open_scene', { path: a.path }); return
      }
      if (a.type === 'key' || a.type === 'pointer') {
        if (!this.supportsInput()) throw new Error('Legacy input is view-only; use Unity for hands-on play')
        if (s.playMode !== 'playing') throw new Error('Input requires running Play Mode')
        if (a.type === 'key') {
          if (!/^[A-Za-z][A-Za-z0-9]{0,30}$/.test(a.key)) throw new Error('Invalid key')
          await this.call('simulate_key', { key: a.key, action: 'press' })
        } else {
          if (![a.x, a.y].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('Pointer coordinates must be normalized 0–1')
          // Fixed read-only query, never model-provided C#. Snapshot pixels may differ
          // from render pixels; Screen.width is unreliable in an editor callback.
          const viewport = await this.call<{ success: boolean; result: { x: number; y: number } }>('eval', { code: 'var t = typeof(UnityEditor.EditorApplication).Assembly.GetType("UnityEditor.PlayModeView"); var m = t.GetMethod("GetMainPlayModeViewTargetSize", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic); var s = (UnityEngine.Vector2)m.Invoke(null, null); return new { x = s.x, y = s.y };' })
          if (!viewport.success || !(viewport.result?.x > 0 && viewport.result?.y > 0)) throw new Error('Cannot determine Game view dimensions')
          if (!stillAllowed()) throw new Error('Player took control')
          await this.call('simulate_pointer', { x: Math.min(viewport.result.x - 1, a.x * viewport.result.x), y: Math.min(viewport.result.y - 1, (1 - a.y) * viewport.result.y), action: 'click' })
        }
        return
      }
      await this.call(a.type === 'play' ? 'editor_play' : a.type === 'pause' ? 'editor_pause' : 'editor_stop')
    })
  }
  private hasPackage(): boolean {
    try { return !!JSON.parse(fs.readFileSync(path.join(this.root, 'Packages/manifest.json'), 'utf8')).dependencies?.['com.genio.play'] } catch { return false }
  }
  stream(session?: { port: number; token: string; width: number; height: number }): Promise<void> {
    return this.serial(async () => { await this.call(session ? 'genio_stream_start' : 'genio_stream_stop', session ?? {}) })
  }
  frame(width: number, height: number): Promise<PlayFrame> {
    if (![width, height].every(v => Number.isInteger(v) && v >= 1 && v <= 1920)) throw new Error('Snapshot dimensions must be 1–1920')
    return this.serial(async () => {
      const started = Date.now()
      const f = await this.call<{ base64: string; width: number; height: number }>('capture_game_view', { width, height, source: 'screen' })
      if (!f.base64 || !/^[A-Za-z0-9+/=]+$/.test(f.base64) || !Buffer.from(f.base64, 'base64').subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Invalid Unity PNG')
      return { base64: f.base64, width: f.width, height: f.height, capturedAt: new Date().toISOString(), latencyMs: Date.now() - started }
    })
  }
  console(cursor?: number, session?: string): Promise<PlayConsole> {
    return this.serial(() => this.call('console', { tail: 100, ...(cursor !== undefined ? { since: cursor, since_session: session } : {}) }))
  }
  stats(): Promise<PlayStats> {
    return this.serial(async () => {
      const stats = await this.call<PlayStats>('get_performance_stats')
      const clock = await this.call<{ success: boolean; result: number | null }>('eval', { code: 'return UnityEditor.EditorApplication.isPlaying && !UnityEditor.EditorApplication.isPaused && UnityEngine.Time.unscaledDeltaTime > 0 ? (double?)(1.0 / UnityEngine.Time.unscaledDeltaTime) : null;' }).catch(() => undefined)
      return { ...stats, ...(clock?.success && typeof clock.result === 'number' && Number.isFinite(clock.result) ? { fps: clock.result } : {}) }
    })
  }
}
