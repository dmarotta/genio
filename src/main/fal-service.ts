/**
 * FAL screen backend: runs FAL requests from the main process with the stored
 * key, keeps the history, downloads outputs into Genio's data dir (served to
 * the renderer over genio-media://) and copies them into a world on request.
 */
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { FalOutput, FalRun, FalRunRequest, FalSaveRequest, FalSaveResult, OpResult } from '@shared/api'
import { bus } from './bus'
import { FalClient, extractCost, extractOutputs, inlineData, pollResult, validEndpoint, type FalSubmit, type FetchFn } from './fal'
import { FalHistory, IN_FLIGHT } from './fal-history'
import { getSecret } from './secrets'
import type { AppCtx, FalService } from './services'
import { ensureDir, exists, isSubPath, nowIso, rid } from './util'

export const MEDIA_SCHEME = 'genio-media'
const MAX_DOWNLOAD = 1024 * 1024 * 1024
const LOG_KEEP = 40

export const mediaUrl = (runId: string, fileName: string): string => `${MEDIA_SCHEME}://fal/${runId}/${encodeURIComponent(fileName)}`

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** A plain file name: no folders, no characters Windows refuses, no leading dots. */
export function safeFileName(name: string, fallback = 'output'): string {
  const base = (name.replace(/\\/g, '/').split('/').pop() ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\x00-\x1f]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 120)
  return base || fallback
}

/** Absolute target inside a world; throws when it would escape the world or land in .git. */
export function worldTarget(root: string, folder: string, fileName: string): string {
  const name = safeFileName(fileName, '')
  if (!name) throw new Error('The file name is empty.')
  const dir = path.resolve(root, folder.trim().replace(/^[\\/]+/, ''))
  if (!isSubPath(dir, root)) throw new Error('That folder is outside the world.')
  if (path.relative(path.resolve(root), dir).split(/[\\/]/)[0].toLowerCase() === '.git') throw new Error('Refusing to write inside .git.')
  return path.join(dir, name)
}

function uniqueName(name: string, used: Set<string>): string {
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let n = name
  for (let i = 2; used.has(n.toLowerCase()); i++) n = `${stem}-${i}${ext}`
  used.add(n.toLowerCase())
  return n
}

function decodeDataUri(uri: string): Buffer {
  const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(uri)
  if (!m) throw new Error('bad data URI')
  return m[1] ? Buffer.from(m[2], 'base64') : Buffer.from(decodeURIComponent(m[2]), 'utf8')
}

/** Fetch one output (no key: FAL's CDN URLs are public) into the run folder. */
export async function downloadOutput(o: FalOutput, dest: string, fetchFn: FetchFn): Promise<{ size: number; contentType?: string }> {
  ensureDir(path.dirname(dest))
  const data = inlineData(o)
  let buf: Buffer
  let contentType = o.contentType
  if (data) buf = decodeDataUri(data)
  else {
    if (!o.url.startsWith('https://')) throw new Error('not an https URL')
    const res = await fetchFn(o.url)
    if (!res.ok) throw new Error(`download failed (${res.status})`)
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > MAX_DOWNLOAD) throw new Error('file is larger than 1 GB')
    buf = Buffer.from(await res.arrayBuffer())
    contentType ??= res.headers.get('content-type')?.split(';')[0] || undefined
  }
  const tmp = `${dest}.part`
  fs.writeFileSync(tmp, buf)
  fs.renameSync(tmp, dest)
  return { size: buf.length, contentType }
}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.opus': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.json': 'application/json', '.txt': 'text/plain'
}

/** Serve a local output with Range support (video/audio seeking). */
export function mediaResponse(file: string, range: string | null): Response {
  const size = fs.statSync(file).size
  const headers: Record<string, string> = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache'
  }
  const body = (start?: number, end?: number): ReadableStream =>
    Readable.toWeb(fs.createReadStream(file, start === undefined ? undefined : { start, end })) as ReadableStream
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
    return new Response(body(start, end), { status: 206, headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` } })
  }
  return new Response(body(), { status: 200, headers: { ...headers, 'Content-Length': String(size) } })
}

export function createFalService(getCtx: () => AppCtx, fetchFn: FetchFn = (u, i) => fetch(u, i)): FalService {
  let hist: FalHistory | undefined
  const history = (): FalHistory => (hist ??= new FalHistory(path.join(getCtx().main.home.data, 'fal')))
  const key = (): string | undefined => getSecret('fal', getCtx().main.home.data)
  const client = (): FalClient => new FalClient(key, fetchFn)
  /** runs being polled in this session */
  const active = new Set<string>()
  /** runs the player cancelled; pollers stop at their next check */
  const stopped = new Set<string>()

  const set = (id: string, patch: Partial<FalRun>): FalRun | undefined => {
    const r = history().update(id, patch)
    if (r) bus.publish({ type: 'fal-run', run: r })
    return r
  }
  const fail = (id: string, error: string): void => {
    set(id, { status: 'failed', error, completedAt: nowIso(), queuePosition: undefined })
  }

  async function fetchOutputs(id: string, outputs: FalOutput[]): Promise<FalOutput[]> {
    const used = new Set<string>()
    const out: FalOutput[] = []
    for (const o of outputs) {
      const name = uniqueName(safeFileName(o.fileName), used)
      const dest = history().filePath(id, name)
      if (!dest) {
        out.push({ ...o, fileName: name, downloadError: 'bad file name' })
        continue
      }
      try {
        const d = await downloadOutput(o, dest, fetchFn)
        out.push({ ...o, fileName: name, localPath: dest, mediaUrl: mediaUrl(id, name), size: o.size ?? d.size, contentType: d.contentType })
      } catch (e) {
        out.push({ ...o, fileName: name, downloadError: errMsg(e) })
      }
    }
    return out
  }

  async function drive(id: string, input?: Record<string, unknown>): Promise<void> {
    if (active.has(id)) return
    active.add(id)
    const c = client()
    try {
      const r = history().get(id)
      if (!r) return
      let sub: FalSubmit
      if (r.requestId && r.statusUrl && r.responseUrl) {
        sub = { requestId: r.requestId, statusUrl: r.statusUrl, responseUrl: r.responseUrl, cancelUrl: r.cancelUrl ?? '' }
      } else if (input) {
        sub = await c.submit(r.endpoint, input)
        const ids = { requestId: sub.requestId, statusUrl: sub.statusUrl, responseUrl: sub.responseUrl, cancelUrl: sub.cancelUrl }
        if (stopped.has(id)) {
          // cancelled while submitting: cancel the request FAL just accepted
          await c.cancel(sub.cancelUrl).catch(() => false)
          set(id, { ...ids, status: 'cancelled', completedAt: nowIso() })
          return
        }
        set(id, { ...ids, status: 'queued', queuePosition: sub.queuePosition })
      } else {
        fail(id, 'Interrupted before FAL accepted the request.')
        return
      }
      const result = await pollResult(c, sub, {
        stopped: () => stopped.has(id),
        onStatus: (st) => {
          if (stopped.has(id)) return
          const cur = history().get(id)
          if (!cur) return
          const patch: Partial<FalRun> = {}
          if (st.status === 'IN_QUEUE' && (cur.status !== 'queued' || cur.queuePosition !== st.queuePosition)) {
            patch.status = 'queued'
            patch.queuePosition = st.queuePosition
          }
          if (st.status !== 'IN_QUEUE' && cur.status !== 'running') {
            patch.status = 'running'
            patch.queuePosition = undefined
            patch.startedAt = cur.startedAt ?? nowIso()
          }
          const logs = st.logs.slice(-LOG_KEEP)
          if (logs.length && logs.join('\n') !== cur.logs.join('\n')) patch.logs = logs
          if (Object.keys(patch).length) set(id, patch)
        }
      })
      if (result === undefined || stopped.has(id)) return
      const found = extractOutputs(result)
      set(id, { result, costUsd: extractCost(result) })
      const outputs = await fetchOutputs(id, found)
      set(id, { status: 'completed', outputs, completedAt: nowIso(), queuePosition: undefined })
      bus.publish({ type: 'sfx', sound: 'ready' })
    } catch (e) {
      if (!stopped.has(id)) fail(id, errMsg(e))
    } finally {
      active.delete(id)
      stopped.delete(id)
    }
  }

  return {
    runs: () => history().list(),

    run(req: FalRunRequest): FalRun {
      const endpoint = req.endpoint.trim().replace(/^https?:\/\/(?:queue\.)?fal\.run\//i, '').replace(/^\/+|\/+$/g, '')
      if (!validEndpoint(endpoint)) throw new Error(`Not a FAL endpoint id: "${req.endpoint}". Use the form owner/app[/path], e.g. fal-ai/flux/dev.`)
      if (!req.input || typeof req.input !== 'object' || Array.isArray(req.input)) throw new Error('Input must be a JSON object.')
      if (!key()) throw new Error('No FAL.ai key set. Add one in Systems → Accounts.')
      const run: FalRun = {
        id: `fal-${Date.now().toString(36)}-${rid(2)}`,
        endpoint,
        input: req.input,
        status: 'submitting',
        logs: [],
        outputs: [],
        createdAt: nowIso()
      }
      const rec = history().add(run)
      bus.publish({ type: 'fal-run', run: rec })
      void drive(run.id, req.input)
      return rec
    },

    async cancel(id: string): Promise<OpResult> {
      const r = history().get(id)
      if (!r) return { ok: false, message: 'No such run.' }
      if (!IN_FLIGHT.has(r.status)) return { ok: false, message: `This run is already ${r.status}.` }
      stopped.add(id)
      if (r.cancelUrl) {
        let accepted: boolean
        try {
          accepted = await client().cancel(r.cancelUrl)
        } catch (e) {
          stopped.delete(id)
          return { ok: false, message: errMsg(e) }
        }
        if (!accepted) {
          stopped.delete(id)
          if (!active.has(id)) void drive(id)
          return { ok: false, message: 'FAL already finished this request; fetching the result.' }
        }
      }
      set(id, { status: 'cancelled', completedAt: nowIso(), queuePosition: undefined })
      return { ok: true, message: 'Run cancelled.' }
    },

    remove(id: string): OpResult {
      const r = history().get(id)
      if (!r) return { ok: false, message: 'No such run.' }
      if (IN_FLIGHT.has(r.status)) return { ok: false, message: 'Cancel the run before deleting it.' }
      history().remove(id)
      return { ok: true, message: 'Run and its files deleted.' }
    },

    async save(req: FalSaveRequest): Promise<FalSaveResult> {
      const r = history().get(req.runId)
      const o = r?.outputs[req.output]
      if (!r || !o) throw new Error('No such output.')
      const proj = getCtx().projects.get(req.project)
      if (!proj) throw new Error(`No world named ${req.project}.`)
      let src = o.localPath
      if (!src || !exists(src)) {
        // the local copy is missing (download failed or was deleted): fetch it again
        const [again] = await fetchOutputs(r.id, [o])
        if (!again.localPath) return { ok: false, message: `The output could not be downloaded: ${again.downloadError ?? 'unknown error'}` }
        set(r.id, { outputs: r.outputs.map((x, i) => (i === req.output ? again : x)) })
        src = again.localPath
      }
      const target = worldTarget(proj.path, req.folder, req.fileName)
      const rel = path.relative(proj.path, target).replace(/\\/g, '/')
      if (exists(target) && !req.overwrite) return { ok: false, exists: true, path: target, message: `${rel} already exists in ${proj.name}.` }
      ensureDir(path.dirname(target))
      fs.copyFileSync(src, target, req.overwrite ? 0 : fs.constants.COPYFILE_EXCL)
      return { ok: true, path: target, message: `Saved to ${proj.name}/${rel}` }
    },

    resume(): void {
      for (const r of history().inFlight()) {
        if (r.requestId && r.statusUrl && r.responseUrl) void drive(r.id)
        else fail(r.id, 'Interrupted before FAL accepted the request (Genio restarted).')
      }
    },

    mediaPath(id: string, fileName: string): string | undefined {
      const p = history().filePath(id, fileName)
      return p && exists(p) ? p : undefined
    }
  }
}
