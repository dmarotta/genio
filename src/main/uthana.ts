/**
 * Uthana GraphQL client (https://uthana.com/graphql) for the main process.
 * HTTP Basic auth with the API key as the user name and an empty password.
 * The key is read from the secret store per call, sent only to uthana.com
 * (never to a CDN a download redirects to), and kept out of every error message.
 * Shapes follow uthana.com/docs/api and the official @uthana/client.
 */
import {
  UTHANA_GRAPHQL, UTHANA_ORIGIN, jobError, jobMotionIds, jobResult, type UthanaAccount, type UthanaRemoteCharacter, type UthanaTextParams
} from '@shared/uthana'
import type { FetchFn } from './fal'

export class UthanaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string
  ) {
    super(message)
  }
}

const NO_KEY = 'No Uthana key set. Add one in Systems → Accounts.'
const MAX_BYTES = 512 * 1024 * 1024

/** Raw job as the API returns it. */
export interface UthanaJob {
  id: string
  status: string
  result?: unknown
  est_processing_time?: number
  created_at?: string
  started_at?: string
  ended_at?: string
}

export const CREATE_TEXT_TO_MOTION = `mutation CreateTextToMotion($prompt: String!, $character_id: String, $model: String!, $foot_ik: Boolean, $steps: Int, $cfg_scale: Float, $length: Float, $seed: Int, $retargeting_ik: Boolean) {
  create_text_to_motion(prompt: $prompt, character_id: $character_id, model: $model, foot_ik: $foot_ik, steps: $steps, cfg_scale: $cfg_scale, length: $length, seed: $seed, retargeting_ik: $retargeting_ik) { motion { id name } }
}`

export const CREATE_TEXT_TO_MOTION_JOB = `mutation CreateTextToMotionJob($prompt: String!, $model: String!, $character_id: String, $length: Float, $rewrite_prompt: Boolean, $fast: Boolean) {
  create_text_to_motion_job(prompt: $prompt, model: $model, character_id: $character_id, length: $length, rewrite_prompt: $rewrite_prompt, fast: $fast) { job { id status est_processing_time } }
}`

export const CREATE_VIDEO_TO_MOTION = `mutation CreateVideoToMotion($file: Upload!, $motion_name: String!, $model: String) {
  create_video_to_motion(file: $file, motion_name: $motion_name, model: $model) { job { id status } }
}`

export const CREATE_CHARACTER = `mutation CreateCharacter($name: String!, $file: Upload!, $auto_rig: Boolean, $auto_rig_front_facing: Boolean, $rerig_target: String, $include_fingers: Boolean) {
  create_character(name: $name, file: $file, auto_rig: $auto_rig, auto_rig_front_facing: $auto_rig_front_facing, rerig_target: $rerig_target, include_fingers: $include_fingers) { character { id name } auto_rig_confidence message }
}`

export const GET_JOB = `query GetJob($job_id: String!) { job(job_id: $job_id) { id status created_at started_at ended_at result } }`

const ACCOUNT = `query Account { user { name } org { name motion_download_secs_per_month motion_download_secs_per_month_remaining characters_allowed characters_allowed_remaining } }`
/** fields the official client reads but the public reference does not list: asked separately, failures ignored */
const PAYG = `query Payg { org { payg_enabled payg_total_usd } payg_prices { model_key billing_unit unit_price } }`
const CHARACTERS = `query Characters { characters { id name created } }`

/** Text-to-motion request: the model id as the API takes it plus the form's parameters. */
export interface TextToMotionRequest extends UthanaTextParams {
  model: string
  characterId?: string
}

export interface UploadFile {
  bytes: Uint8Array
  fileName: string
  mime?: string
}

export interface CreatedCharacter {
  id: string
  name: string
  autoRigConfidence?: number
  message?: string
}

const isUthanaUrl = (u: string): boolean => {
  try {
    const url = new URL(u)
    return url.protocol === 'https:' && url.host === new URL(UTHANA_ORIGIN).host
  } catch {
    return false
  }
}

/** Uthana's own words for an HTTP failure, with a pointer to the key on 401/403. */
export function uthanaHttpMessage(status: number, body: string): string {
  let msg = ''
  try {
    const j = JSON.parse(body) as { errors?: { message?: string }[]; message?: string; detail?: string }
    msg = j.errors?.[0]?.message ?? j.message ?? j.detail ?? ''
  } catch {
    msg = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
  }
  if (status === 401) return `Uthana rejected the key (401)${msg ? `: ${msg}` : ''}. Check it in Systems → Accounts.`
  if (status === 403) return `Uthana refused the request (403)${msg ? `: ${msg}` : ''}. Check the plan's quota or credits at uthana.com/app/account.`
  return `Uthana error ${status}${msg ? `: ${msg}` : ''}`
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined)

/** Drop undefined so the API applies its own defaults. */
const defined = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

export class UthanaClient {
  constructor(
    private readonly key: () => string | undefined,
    private readonly fetchFn: FetchFn = (u, i) => fetch(u, i)
  ) {}

  private auth(): string {
    const k = this.key()
    if (!k) throw new UthanaError(NO_KEY)
    return `Basic ${Buffer.from(`${k}:`, 'utf8').toString('base64')}`
  }

  /** Never let the key reach a message (Uthana could echo it back). */
  private scrub(msg: string): string {
    const k = this.key()
    return k && k.length >= 6 ? msg.split(k).join('••••') : msg
  }

  private async send(body: BodyInit, json: boolean, timeoutMs: number): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { Accept: 'application/json', Authorization: this.auth() }
    if (json) headers['Content-Type'] = 'application/json'
    let res: Response
    try {
      res = await this.fetchFn(UTHANA_GRAPHQL, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      throw new UthanaError(this.scrub(`Could not reach Uthana: ${(e as Error)?.message ?? e}`))
    }
    const text = await res.text()
    if (!res.ok) throw new UthanaError(this.scrub(uthanaHttpMessage(res.status, text)), res.status)
    let out: { data?: Record<string, unknown> | null; errors?: { message?: string; extensions?: { code?: string } }[] }
    try {
      out = JSON.parse(text)
    } catch {
      throw new UthanaError('Uthana returned a response that is not JSON.', res.status)
    }
    if (out.errors?.length) {
      const e = out.errors[0]
      throw new UthanaError(this.scrub(`Uthana: ${e.message ?? 'GraphQL error'}`), 400, e.extensions?.code)
    }
    return out.data ?? {}
  }

  /** POST a GraphQL query or mutation; returns `data`. */
  gql(query: string, variables: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<Record<string, unknown>> {
    return this.send(JSON.stringify({ query, variables }), true, timeoutMs)
  }

  /** A mutation with one file, per the GraphQL multipart request spec (operations / map / 0). */
  upload(query: string, variables: Record<string, unknown>, fileVar: string, file: UploadFile, timeoutMs = 360_000): Promise<Record<string, unknown>> {
    const form = new FormData()
    form.append('operations', JSON.stringify({ query, variables: { ...variables, [fileVar]: null } }))
    form.append('map', JSON.stringify({ '0': [`variables.${fileVar}`] }))
    form.append('0', new Blob([new Uint8Array(file.bytes)], { type: file.mime ?? 'application/octet-stream' }), file.fileName)
    return this.send(form, false, timeoutMs)
  }

  /** The free key check from the docs: `{ __typename }` answers "Query" for a valid key. */
  async ping(): Promise<boolean> {
    const d = await this.gql('{ __typename }')
    return d.__typename === 'Query'
  }

  /** Free account queries: who, quotas and (when the API offers them) pay-as-you-go figures. */
  async account(): Promise<UthanaAccount> {
    const d = await this.gql(ACCOUNT)
    const org = (d.org ?? {}) as Record<string, unknown>
    const user = (d.user ?? {}) as Record<string, unknown>
    const a: UthanaAccount = {
      org: typeof org.name === 'string' ? org.name : undefined,
      user: typeof user.name === 'string' ? user.name : undefined,
      downloadSecsPerMonth: num(org.motion_download_secs_per_month),
      downloadSecsRemaining: num(org.motion_download_secs_per_month_remaining),
      charactersAllowed: num(org.characters_allowed),
      charactersRemaining: num(org.characters_allowed_remaining),
      checkedAt: new Date().toISOString()
    }
    try {
      const p = await this.gql(PAYG)
      const po = (p.org ?? {}) as Record<string, unknown>
      if (typeof po.payg_enabled === 'boolean') a.paygEnabled = po.payg_enabled
      a.paygTotalUsd = num(po.payg_total_usd)
      if (Array.isArray(p.payg_prices)) {
        a.prices = (p.payg_prices as Record<string, unknown>[]).map((x) => ({ model: String(x.model_key ?? ''), unit: String(x.billing_unit ?? ''), price: String(x.unit_price ?? '') })).filter((x) => x.model)
      }
    } catch {
      /* not offered to this account or not in the schema: the documented fields are enough */
    }
    return a
  }

  async characters(): Promise<UthanaRemoteCharacter[]> {
    const d = await this.gql(CHARACTERS)
    const list = Array.isArray(d.characters) ? (d.characters as Record<string, unknown>[]) : []
    return list.filter((c) => typeof c.id === 'string').map((c) => ({ id: c.id as string, name: typeof c.name === 'string' ? c.name : (c.id as string), created: typeof c.created === 'string' ? c.created : undefined }))
  }

  /** Text-to-motion 1.0 / 2.0: the motion comes back in the response. */
  async textToMotion(req: TextToMotionRequest): Promise<{ id: string; name?: string }> {
    const bucmd = req.model === 'text-to-motion-bucmd'
    const vars = defined({
      prompt: req.prompt,
      model: req.model,
      character_id: req.characterId,
      foot_ik: req.foot_ik,
      // the advanced parameters exist only on the 2.0 (BUCMD) model
      steps: bucmd ? req.steps : undefined,
      cfg_scale: bucmd ? req.cfg_scale : undefined,
      length: bucmd ? req.length : undefined,
      seed: bucmd ? req.seed : undefined,
      retargeting_ik: bucmd ? req.retargeting_ik : undefined
    })
    const d = await this.gql(CREATE_TEXT_TO_MOTION, vars, 300_000)
    const motion = (d.create_text_to_motion as { motion?: { id?: string; name?: string } } | null)?.motion
    if (!motion?.id) throw new UthanaError('Uthana returned no motion id. The motion may still have been created: check uthana.com/app before trying again.')
    return { id: motion.id, name: motion.name }
  }

  /** Text-to-motion 3.0: an async job to poll. */
  async textToMotionJob(req: TextToMotionRequest): Promise<UthanaJob> {
    const vars = defined({
      prompt: req.prompt,
      model: req.model,
      character_id: req.characterId,
      length: req.length,
      rewrite_prompt: req.rewrite_prompt,
      fast: req.fast ?? false
    })
    const d = await this.gql(CREATE_TEXT_TO_MOTION_JOB, vars)
    return this.jobOf((d.create_text_to_motion_job as { job?: unknown } | null)?.job)
  }

  async videoToMotion(file: UploadFile, motionName: string, model: string): Promise<UthanaJob> {
    const d = await this.upload(CREATE_VIDEO_TO_MOTION, { motion_name: motionName, model }, 'file', file)
    return this.jobOf((d.create_video_to_motion as { job?: unknown } | null)?.job)
  }

  async createCharacter(
    file: UploadFile,
    opts: { name: string; autoRig?: boolean; frontFacing?: boolean; rerigTarget?: string; includeFingers?: boolean }
  ): Promise<CreatedCharacter> {
    const vars = defined({
      name: opts.name,
      auto_rig: opts.autoRig,
      auto_rig_front_facing: opts.frontFacing,
      rerig_target: opts.rerigTarget || undefined,
      include_fingers: opts.includeFingers
    })
    // auto-rigging takes 30-60 s and the server gives up at 300 s
    const d = await this.upload(CREATE_CHARACTER, vars, 'file', file, 330_000)
    const c = d.create_character as { character?: { id?: string; name?: string }; auto_rig_confidence?: unknown; message?: unknown } | null
    if (!c?.character?.id) throw new UthanaError('Uthana returned no character id.')
    return {
      id: c.character.id,
      name: c.character.name ?? opts.name,
      autoRigConfidence: num(c.auto_rig_confidence),
      message: typeof c.message === 'string' && c.message ? c.message : undefined
    }
  }

  async job(id: string): Promise<UthanaJob> {
    const d = await this.gql(GET_JOB, { job_id: id })
    if (!d.job) throw new UthanaError(`Uthana has no job ${id}.`, 404)
    return this.jobOf(d.job)
  }

  private jobOf(v: unknown): UthanaJob {
    const j = v as Record<string, unknown> | null | undefined
    if (!j || typeof j.id !== 'string') throw new UthanaError('Uthana returned no job id.')
    return {
      id: j.id,
      status: typeof j.status === 'string' ? j.status : '',
      result: j.result === null ? undefined : jobResult(j.result) ?? j.result,
      est_processing_time: num(j.est_processing_time),
      created_at: typeof j.created_at === 'string' ? j.created_at : undefined,
      started_at: typeof j.started_at === 'string' ? j.started_at : undefined,
      ended_at: typeof j.ended_at === 'string' ? j.ended_at : undefined
    }
  }

  /**
   * GET a file from uthana.com with the key. Redirects are followed by hand so
   * the key goes only to uthana.com: a CDN the download redirects to gets none.
   */
  async download(url: string, timeoutMs = 300_000): Promise<Buffer> {
    if (!isUthanaUrl(url)) throw new UthanaError('Refusing to send the Uthana key outside uthana.com.')
    let current = url
    for (let hop = 0; hop < 6; hop++) {
      const own = isUthanaUrl(current)
      let res: Response
      try {
        res = await this.fetchFn(current, { headers: own ? { Authorization: this.auth() } : {}, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
      } catch (e) {
        throw new UthanaError(this.scrub(`Download failed: ${(e as Error)?.message ?? e}`))
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (!loc) throw new UthanaError(`Uthana answered ${res.status} without a location.`)
        current = new URL(loc, current).toString()
        if (!current.startsWith('https://')) throw new UthanaError('Refusing a download redirect that is not https.')
        continue
      }
      if (!res.ok) throw new UthanaError(this.scrub(uthanaHttpMessage(res.status, await res.text())), res.status)
      if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) throw new UthanaError('The file is larger than 512 MB.')
      return Buffer.from(await res.arrayBuffer())
    }
    throw new UthanaError('Too many redirects.')
  }
}

export interface JobPollOpts {
  intervalMs?: number
  timeoutMs?: number
  /** stop early (the player stopped waiting) */
  stopped?: () => boolean
  onStatus?: (job: UthanaJob) => void
  sleep?: (ms: number) => Promise<void>
}

/**
 * Poll a job until FINISHED (returns it with its motion ids) or FAILED (throws
 * Uthana's reason). Returns undefined when stopped. The docs poll every 5 s.
 */
export async function pollJob(client: UthanaClient, jobId: string, opts: JobPollOpts = {}): Promise<{ job: UthanaJob; motionIds: string[] } | undefined> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const deadline = Date.now() + (opts.timeoutMs ?? 45 * 60_000)
  let misses = 0
  for (;;) {
    if (opts.stopped?.()) return undefined
    let job: UthanaJob
    try {
      job = await client.job(jobId)
      misses = 0
    } catch (e) {
      // a transient network failure should not lose a paid job: retry a few times
      if (e instanceof UthanaError && e.status !== undefined && e.status < 500) throw e
      if (++misses >= 5) throw e
      await sleep(opts.intervalMs ?? 5000)
      continue
    }
    if (opts.stopped?.()) return undefined
    opts.onStatus?.(job)
    const st = job.status.toUpperCase()
    if (st === 'FINISHED') {
      const motionIds = jobMotionIds(job.result)
      if (!motionIds.length) throw new UthanaError('The job finished but its result has no motion id.')
      return { job, motionIds }
    }
    if (st === 'FAILED') throw new UthanaError(`Uthana job failed: ${jobError(job.result)}`)
    if (Date.now() > deadline) throw new UthanaError('Timed out waiting for Uthana. The job may still finish: check uthana.com/app.')
    await sleep(opts.intervalMs ?? 5000)
  }
}
