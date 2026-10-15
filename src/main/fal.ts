/**
 * FAL.ai REST queue client (main process only): submit → poll status → fetch
 * the result. The key comes from a getter at call time and only ever goes into
 * the Authorization header of requests to FAL's own queue hosts; it is never
 * logged, stored or put in an error message.
 */
import type { FalOutput, FalOutputKind } from '@shared/api'
import { settingsPath } from '@shared/settings-pages'

export const FAL_QUEUE = 'https://queue.fal.run'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface FalSubmit {
  requestId: string
  statusUrl: string
  responseUrl: string
  cancelUrl: string
  queuePosition?: number
}

export type FalQueueState = 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED'

export interface FalStatus {
  status: FalQueueState
  queuePosition?: number
  logs: string[]
  /** set when FAL reports the request failed */
  error?: string
}

/** owner/app[/path...]: letters, digits, dot, dash, underscore; no '..'. */
export function validEndpoint(id: string): boolean {
  return /^[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*$/.test(id) && !id.split('/').some((s) => s === '.' || s === '..')
}

/** The key is only ever sent to FAL's queue hosts over https. */
export function isFalQueueUrl(u: string): boolean {
  try {
    const url = new URL(u)
    return url.protocol === 'https:' && (url.hostname === 'queue.fal.run' || url.hostname.endsWith('.fal.run'))
  } catch {
    return false
  }
}

/** Queue URLs are keyed by app id (owner/app), not the full endpoint path. */
export function appId(endpoint: string): string {
  return endpoint.split('/').slice(0, 2).join('/')
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

export function parseSubmit(json: unknown, endpoint: string): FalSubmit {
  const j = (json ?? {}) as Record<string, unknown>
  const requestId = str(j.request_id)
  if (!requestId) throw new Error('FAL did not return a request id.')
  const base = `${FAL_QUEUE}/${appId(endpoint)}/requests/${encodeURIComponent(requestId)}`
  const pick = (v: unknown, fallback: string): string => {
    const s = str(v)
    return s && isFalQueueUrl(s) ? s : fallback
  }
  return {
    requestId,
    statusUrl: pick(j.status_url, `${base}/status`),
    responseUrl: pick(j.response_url, base),
    cancelUrl: pick(j.cancel_url, `${base}/cancel`),
    queuePosition: num(j.queue_position)
  }
}

function logLines(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((l) => (typeof l === 'string' ? l : str((l as { message?: unknown })?.message)))
    .filter((l): l is string => Boolean(l))
}

export function parseStatus(json: unknown): FalStatus {
  const j = (json ?? {}) as Record<string, unknown>
  const s = str(j.status)
  if (s !== 'IN_QUEUE' && s !== 'IN_PROGRESS' && s !== 'COMPLETED') throw new Error(`Unexpected FAL status: ${s ?? 'none'}`)
  const err = j.error ? (typeof j.error === 'string' ? j.error : detailText(j.error)) : undefined
  return { status: s, queuePosition: num(j.queue_position), logs: logLines(j.logs), error: err || undefined }
}

/** FAL error bodies: {detail: "..."} or {detail: [{loc, msg}]} (validation). */
export function detailText(detail: unknown): string {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        const o = d as { loc?: unknown; msg?: unknown }
        const loc = Array.isArray(o.loc) ? o.loc.filter((x) => x !== 'body').join('.') : ''
        const msg = str(o.msg) ?? JSON.stringify(d)
        return loc ? `${loc}: ${msg}` : msg
      })
      .join('; ')
  }
  if (detail && typeof detail === 'object') {
    const o = detail as Record<string, unknown>
    return str(o.message) ?? str(o.msg) ?? detailText(o.detail ?? JSON.stringify(o))
  }
  return String(detail)
}

export function falErrorMessage(status: number, body: string): string {
  let msg = ''
  try {
    const j = JSON.parse(body) as Record<string, unknown>
    msg = detailText(j.detail ?? j.error ?? j.message ?? '')
  } catch {
    msg = body.trim().slice(0, 300)
  }
  if (status === 401 || status === 403) return `FAL rejected the key (${status})${msg ? `: ${msg}` : ''}. Check it in ${settingsPath('accounts')}.`
  return `FAL error ${status}${msg ? `: ${msg}` : ''}`
}

export class FalClient {
  constructor(
    private readonly key: () => string | undefined,
    private readonly fetchFn: FetchFn = (u, i) => fetch(u, i)
  ) {}

  private async call(url: string, init: RequestInit = {}): Promise<unknown> {
    if (!isFalQueueUrl(url)) throw new Error('Refusing to send the FAL key outside queue.fal.run.')
    const key = this.key()
    if (!key) throw new Error(`No FAL.ai key set. Add one in ${settingsPath('accounts')}.`)
    const res = await this.fetchFn(url, {
      ...init,
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Key ${key}` }
    })
    const text = await res.text()
    if (!res.ok) throw new FalHttpError(res.status, falErrorMessage(res.status, text))
    if (!text.trim()) return {}
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error('FAL returned a response that is not JSON.')
    }
  }

  async submit(endpoint: string, input: Record<string, unknown>): Promise<FalSubmit> {
    if (!validEndpoint(endpoint)) throw new Error(`Not a FAL endpoint id: ${endpoint}`)
    const json = await this.call(`${FAL_QUEUE}/${endpoint}`, { method: 'POST', body: JSON.stringify(input) })
    return parseSubmit(json, endpoint)
  }

  async status(statusUrl: string): Promise<FalStatus> {
    const u = new URL(statusUrl)
    u.searchParams.set('logs', '1')
    return parseStatus(await this.call(u.toString()))
  }

  result(responseUrl: string): Promise<unknown> {
    return this.call(responseUrl)
  }

  /** true when FAL accepted the cancellation (false: it already finished). */
  async cancel(cancelUrl: string): Promise<boolean> {
    try {
      await this.call(cancelUrl, { method: 'PUT' })
      return true
    } catch (e) {
      if (e instanceof FalHttpError && e.status === 400) return false
      throw e
    }
  }
}

export class FalHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export interface PollOpts {
  intervalMs?: number
  timeoutMs?: number
  /** stop early (cancelled by the player) */
  stopped?: () => boolean
  onStatus?: (s: FalStatus) => void
  sleep?: (ms: number) => Promise<void>
}

/** Poll until COMPLETED, then fetch the result. Throws on FAL errors and timeouts. */
export async function pollResult(client: FalClient, sub: FalSubmit, opts: PollOpts = {}): Promise<unknown | undefined> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000)
  let wait = opts.intervalMs ?? 1000
  for (;;) {
    if (opts.stopped?.()) return undefined
    const st = await client.status(sub.statusUrl)
    opts.onStatus?.(st)
    if (st.status === 'COMPLETED') {
      if (st.error) throw new Error(st.error)
      return client.result(sub.responseUrl)
    }
    if (Date.now() > deadline) throw new Error('Timed out waiting for FAL. The request may still finish on fal.ai.')
    await sleep(wait)
    wait = Math.min(wait * 1.5, 5000)
  }
}

// ---------------------------------------------------------------- outputs

const EXT_KIND: [RegExp, FalOutputKind][] = [
  [/\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i, 'image'],
  [/\.(mp3|wav|ogg|flac|m4a|aac|opus)$/i, 'audio'],
  [/\.(mp4|webm|mov|mkv)$/i, 'video'],
  [/\.(glb|gltf|obj|fbx|ply|stl|usdz)$/i, 'model']
]

export function outputKind(contentType: string | undefined, nameOrUrl: string): FalOutputKind {
  const ct = (contentType ?? '').toLowerCase()
  if (ct.startsWith('image/')) return 'image'
  if (ct.startsWith('audio/')) return 'audio'
  if (ct.startsWith('video/')) return 'video'
  if (ct.startsWith('model/') || /gltf|glb|octet-stream.*glb/.test(ct)) return 'model'
  const bare = nameOrUrl.split(/[?#]/)[0]
  for (const [re, k] of EXT_KIND) if (re.test(bare)) return k
  return 'other'
}

const URL_KEY = /(^|_)urls?$/i

/** data: URIs extracted from a result, held beside the output (never stored in history). */
const inline = new WeakMap<FalOutput, string>()

function nameFrom(url: string, fallback: string): string {
  if (url.startsWith('data:')) return fallback
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '')
    return last || fallback
  } catch {
    return fallback
  }
}

function dataUriType(u: string): string | undefined {
  return /^data:([^;,]+)/i.exec(u)?.[1]
}

const EXT_FOR: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'model/gltf-binary': 'glb', 'model/gltf+json': 'gltf'
}

/**
 * Every file in a FAL result: File objects ({url, content_type, file_name, ...})
 * anywhere in the tree, plus bare URL strings under *_url keys.
 */
export function extractOutputs(result: unknown): FalOutput[] {
  const out: FalOutput[] = []
  const seen = new Set<string>()
  const add = (url: string, field: string, meta: Record<string, unknown> = {}): void => {
    if (!/^(https:|data:)/i.test(url) || seen.has(url)) return
    seen.add(url)
    const isData = url.startsWith('data:')
    const ct = str(meta.content_type) ?? (isData ? dataUriType(url) : undefined)
    const ext = ct ? EXT_FOR[ct.toLowerCase()] : undefined
    const fileName = str(meta.file_name) ?? nameFrom(url, `${field.replace(/\W+/g, '-').replace(/^-|-$/g, '') || 'output'}${ext ? `.${ext}` : ''}`)
    out.push({
      kind: outputKind(ct, fileName) === 'other' ? outputKind(ct, url) : outputKind(ct, fileName),
      url: isData ? '' : url,
      field,
      fileName,
      contentType: ct,
      size: num(meta.file_size),
      width: num(meta.width),
      height: num(meta.height)
    })
    if (isData) inline.set(out[out.length - 1], url)
  }
  const walk = (v: unknown, path: string, key: string): void => {
    if (typeof v === 'string') {
      if (URL_KEY.test(key)) add(v, path)
      return
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`, key))
      return
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (typeof o.url === 'string') {
        add(o.url, path || 'output', o)
        return
      }
      for (const [k, x] of Object.entries(o)) walk(x, path ? `${path}.${k}` : k, k)
    }
  }
  walk(result, '', '')
  return out
}

export function inlineData(o: FalOutput): string | undefined {
  return inline.get(o)
}

/** Cost in USD only when FAL puts one in the result; never estimated. */
export function extractCost(result: unknown): number | undefined {
  if (!result || typeof result !== 'object') return undefined
  const o = result as Record<string, unknown>
  for (const k of ['cost_usd', 'cost', 'price_usd', 'price']) {
    const v = num(o[k])
    if (v !== undefined && v >= 0) return v
  }
  for (const k of ['billing', 'usage', 'metrics']) {
    const inner = o[k]
    if (inner && typeof inner === 'object') {
      const v = extractCost(inner)
      if (v !== undefined) return v
    }
  }
  return undefined
}

/** Copy of a result with long strings (inline data, base64) trimmed, for history. */
export function trimForHistory(v: unknown, max = 2000): unknown {
  if (typeof v === 'string') return v.length > max ? `${v.slice(0, 80)}… (${v.length} chars)` : v
  if (Array.isArray(v)) return v.map((x) => trimForHistory(x, max))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trimForHistory(x, max)]))
  return v
}
