/**
 * Animation screen backend (Uthana): runs generations and character uploads
 * from the main process with the stored key, keeps the run history and the
 * per-world character list in Genio's data (data/uthana/), downloads previews
 * and exports into each run's folder (served over genio-media://uthana/) and
 * copies them into a world on request, with the same provenance and spend
 * records as the FAL screen. The key never leaves this process.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { OpResult } from '@shared/api'
import {
  UTHANA_CHARACTER_EXTS, UTHANA_CHARACTER_MAX_BYTES, UTHANA_IN_FLIGHT, UTHANA_PRICES_CHECKED, UTHANA_VIDEO_EXTS, estimateUthana, exportProblems, exportWarnings,
  glbAnimationSeconds, motionFileUrl, motionOnlyUrl, optionsTag, runCost, runStatusOfJob, suggestAnimationFolder, textParamErrors, textParamsFor, uthanaModel,
  uthanaRequestId, uthanaWorldSpend, worldCharacters, type UthanaAccount, type UthanaCharacterRecord, type UthanaExportRequest, type UthanaExportResult,
  type UthanaFile, type UthanaFileInfo, type UthanaGenerateRequest, type UthanaPreviewRequest, type UthanaRemoteCharacter, type UthanaRun, type UthanaUploadRequest,
  type UthanaWorldConfig, type UthanaWorldState
} from '@shared/uthana'
import { monthKey } from '@shared/fal'
import type { Project } from '@shared/types'
import { bus } from './bus'
import type { FetchFn } from './fal'
import { trimForHistory } from './fal'
import { safeFileName, worldTarget } from './fal-service'
import { appendSpend, ensureGenioDir, genioPath, lfsWarnings, provenanceInput, readSpend, readWorldConfig, sha256File, writeProvenance } from './fal-world'
import { getSecret } from './secrets'
import type { AppCtx, UthanaService } from './services'
import { UthanaClient, pollJob, type UploadFile, type UthanaJob } from './uthana'
import { ensureDir, exists, isSubPath, nowIso, readJson, rid, writeJson } from './util'

export const UTHANA_MEDIA_HOST = 'uthana'
const MAX_RUNS = 200
const MIME: Record<string, string> = { fbx: 'application/octet-stream', glb: 'model/gltf-binary', gltf: 'model/gltf+json', mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo' }

export const uthanaMediaUrl = (runId: string, fileName: string): string => `genio-media://${UTHANA_MEDIA_HOST}/${runId}/${encodeURIComponent(fileName)}`

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Length of an MP4/MOV from its movie header (mvhd), or undefined. */
export function mp4Seconds(buf: Uint8Array): number | undefined {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  for (let i = 4; i + 32 <= buf.byteLength; i++) {
    // 'mvhd'
    if (buf[i] !== 0x6d || buf[i + 1] !== 0x76 || buf[i + 2] !== 0x68 || buf[i + 3] !== 0x64) continue
    const v = buf[i + 4]
    const ts = v === 1 ? dv.getUint32(i + 24) : dv.getUint32(i + 16)
    const dur = v === 1 ? Number(dv.getBigUint64(i + 28)) : dv.getUint32(i + 20)
    if (ts > 0 && dur > 0 && dur !== 0xffffffff) return dur / ts
  }
  return undefined
}

/** data/uthana/runs.json (newest first, capped) plus data/uthana/runs/<id>/ files. */
export class UthanaHistory {
  readonly file: string
  readonly runsDir: string
  constructor(readonly dir: string) {
    this.file = path.join(dir, 'runs.json')
    this.runsDir = path.join(dir, 'runs')
  }
  list(): UthanaRun[] {
    const v = readJson<unknown>(this.file, [])
    return Array.isArray(v) ? (v as UthanaRun[]).filter((r) => r && typeof r.id === 'string').map((r) => ({ ...r, files: r.files ?? [] })) : []
  }
  get(id: string): UthanaRun | undefined {
    return this.list().find((r) => r.id === id)
  }
  add(run: UthanaRun): UthanaRun {
    const list = [run, ...this.list().filter((r) => r.id !== run.id)]
    while (list.length > MAX_RUNS) {
      const i = list.map((r) => UTHANA_IN_FLIGHT.has(r.status)).lastIndexOf(false)
      if (i <= 0) break
      this.dropFiles(list[i].id)
      list.splice(i, 1)
    }
    writeJson(this.file, list)
    return run
  }
  update(id: string, patch: Partial<UthanaRun>): UthanaRun | undefined {
    const list = this.list()
    const i = list.findIndex((r) => r.id === id)
    if (i < 0) return undefined
    const next: UthanaRun = { ...list[i], ...patch, id }
    if (patch.result !== undefined) next.result = trimForHistory(patch.result)
    list[i] = next
    writeJson(this.file, list)
    return next
  }
  remove(id: string): boolean {
    const list = this.list()
    const next = list.filter((r) => r.id !== id)
    if (next.length === list.length) return false
    writeJson(this.file, next)
    this.dropFiles(id)
    return true
  }
  runDir(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error(`bad run id: ${id}`)
    return path.join(this.runsDir, id)
  }
  filePath(id: string, fileName: string): string | undefined {
    if (!/^[\w-]+$/.test(id)) return undefined
    const dir = this.runDir(id)
    const p = path.resolve(dir, fileName)
    return isSubPath(p, dir) && p !== path.resolve(dir) ? p : undefined
  }
  private dropFiles(id: string): void {
    try {
      fs.rmSync(this.runDir(id), { recursive: true, force: true })
    } catch {
      /* already gone */
    }
  }
}

export function readUthanaConfig(root: string): UthanaWorldConfig {
  const c = readJson<UthanaWorldConfig>(genioPath(root, 'uthana', 'config.json'), {})
  return c && typeof c === 'object' && !Array.isArray(c) ? c : {}
}

export function createUthanaService(getCtx: () => AppCtx, fetchFn: FetchFn = (u, i) => fetch(u, i), opts: { pollMs?: number } = {}): UthanaService {
  let hist: UthanaHistory | undefined
  const dataDir = (): string => path.join(getCtx().main.home.data, 'uthana')
  const history = (): UthanaHistory => (hist ??= new UthanaHistory(dataDir()))
  const key = (): string | undefined => getSecret('uthana', getCtx().main.home.data)
  const client = (): UthanaClient => new UthanaClient(key, fetchFn)
  const charactersFile = (): string => path.join(dataDir(), 'characters.json')
  const readCharacters = (): UthanaCharacterRecord[] => {
    const v = readJson<unknown>(charactersFile(), [])
    return Array.isArray(v) ? (v as UthanaCharacterRecord[]).filter((c) => c && typeof c.id === 'string') : []
  }

  const project = (name: string): Project => {
    const p = getCtx().projects.get(name)
    if (!p) throw new Error(`No world named ${name}.`)
    return p
  }
  const worldOf = (w?: string | null): string | undefined => {
    const name = w?.trim() || undefined
    if (name) project(name)
    return name
  }
  const requireKey = (): void => {
    if (!key()) throw new Error('No Uthana key set. Add one in Systems → Accounts.')
  }

  const set = (id: string, patch: Partial<UthanaRun>): UthanaRun | undefined => {
    const r = history().update(id, patch)
    if (r) bus.publish({ type: 'uthana-run', run: r })
    return r
  }
  const fail = (id: string, error: string): void => {
    set(id, { status: 'failed', error, completedAt: nowIso() })
  }
  const active = new Set<string>()
  const stopped = new Set<string>()

  /** A local file as an upload: checks the type and size the API accepts. */
  const fileInfo = (p: string, kind: 'character' | 'video', world: string | null): UthanaFileInfo => {
    if (!path.isAbsolute(p) || !exists(p) || !fs.statSync(p).isFile()) throw new Error(`File not found: ${p}`)
    const ext = path.extname(p).slice(1).toLowerCase()
    const ok = kind === 'character' ? UTHANA_CHARACTER_EXTS : UTHANA_VIDEO_EXTS
    if (!ok.includes(ext)) throw new Error(`Uthana takes ${ok.map((e) => `.${e}`).join(', ')} ${kind === 'character' ? 'characters' : 'videos'}, not .${ext || '(none)'}.`)
    const bytes = fs.statSync(p).size
    if (kind === 'character' && bytes >= UTHANA_CHARACTER_MAX_BYTES) throw new Error(`${path.basename(p)} is ${(bytes / 1048576).toFixed(1)} MB; Uthana takes characters under 30 MB.`)
    const info: UthanaFileInfo = { path: p, name: path.basename(p), ext, bytes }
    if (kind === 'video' && ext !== 'avi' && bytes <= 1024 * 1024 * 1024) info.seconds = mp4Seconds(fs.readFileSync(p))
    if (world) {
      const root = project(world).path
      if (isSubPath(p, root)) info.inWorld = path.relative(root, p).replace(/\\/g, '/')
    }
    return info
  }
  const uploadOf = (p: string): UploadFile => {
    const ext = path.extname(p).slice(1).toLowerCase()
    return { bytes: fs.readFileSync(p), fileName: path.basename(p), mime: MIME[ext] }
  }

  async function storeFile(run: UthanaRun, fileName: string, url: string, meta: Omit<UthanaFile, 'fileName' | 'size' | 'mediaUrl' | 'localPath' | 'createdAt'>): Promise<UthanaFile> {
    const dest = history().filePath(run.id, fileName)
    if (!dest) throw new Error('bad file name')
    const buf = await client().download(url)
    ensureDir(path.dirname(dest))
    fs.writeFileSync(`${dest}.part`, buf)
    fs.renameSync(`${dest}.part`, dest)
    const f: UthanaFile = { ...meta, fileName, size: buf.length, mediaUrl: uthanaMediaUrl(run.id, fileName), localPath: dest, createdAt: nowIso() }
    const cur = history().get(run.id) ?? run
    const patch: Partial<UthanaRun> = { files: [...cur.files.filter((x) => x.fileName !== fileName), f] }
    if (meta.format === 'glb' && cur.outputSeconds === undefined && (meta.options.speed ?? 1) === 1) {
      const secs = glbAnimationSeconds(buf)
      if (secs !== undefined) patch.outputSeconds = secs
    }
    set(run.id, patch)
    return f
  }

  /** The motion's skeleton-only GLB right after a generation: free, and gives the real length (and cost). */
  async function autoPreview(id: string): Promise<void> {
    try {
      await svc.preview({ runId: id, source: 'skeleton' })
    } catch {
      /* the player can still ask for a preview */
    }
  }

  async function drive(id: string, req?: UthanaGenerateRequest): Promise<void> {
    if (active.has(id)) return
    active.add(id)
    const c = client()
    try {
      const r = history().get(id)
      if (!r) return
      const m = uthanaModel(r.model)
      let jobId = r.jobId
      if (!jobId) {
        if (!req || !m) {
          fail(id, 'Interrupted before Uthana answered (Genio restarted). The motion may exist anyway: check uthana.com/app.')
          return
        }
        set(id, { status: 'running', startedAt: nowIso() })
        if (m.kind === 'text' && !m.job) {
          const motion = await c.textToMotion({ ...req.text!, model: m.id, characterId: r.characterId })
          if (stopped.has(id)) return
          set(id, { status: 'completed', motionId: motion.id, motionIds: [motion.id], motionName: motion.name ?? req.text!.prompt, completedAt: nowIso() })
          bus.publish({ type: 'sfx', sound: 'ready' })
          void autoPreview(id)
          return
        }
        let job: UthanaJob
        if (m.kind === 'text') job = await c.textToMotionJob({ ...req.text!, model: m.id, characterId: r.characterId })
        else job = await c.videoToMotion(uploadOf(req.video!.path), req.video!.motionName, m.id)
        jobId = job.id
        set(id, { jobId, jobStatus: job.status, status: runStatusOfJob(job.status) === 'queued' ? 'queued' : 'running', estProcessingSecs: job.est_processing_time })
        if (stopped.has(id)) return
      }
      const done = await pollJob(c, jobId, {
        intervalMs: opts.pollMs,
        stopped: () => stopped.has(id),
        onStatus: (j) => {
          const cur = history().get(id)
          if (!cur || cur.jobStatus === j.status) return
          const st = runStatusOfJob(j.status)
          set(id, { jobStatus: j.status, status: st === 'completed' || st === 'failed' ? cur.status : st, startedAt: cur.startedAt ?? (j.started_at || nowIso()) })
        }
      })
      if (!done || stopped.has(id)) return
      const cur = history().get(id)
      set(id, {
        status: 'completed',
        motionId: done.motionIds[0],
        motionIds: done.motionIds,
        motionName: cur?.motionName ?? (typeof cur?.input.prompt === 'string' ? cur.input.prompt : undefined),
        result: done.job.result,
        jobStatus: done.job.status,
        completedAt: nowIso()
      })
      bus.publish({ type: 'sfx', sound: 'ready' })
      void autoPreview(id)
    } catch (e) {
      if (!stopped.has(id)) fail(id, errMsg(e))
    } finally {
      active.delete(id)
      stopped.delete(id)
    }
  }

  async function driveUpload(id: string, req: UthanaUploadRequest): Promise<void> {
    active.add(id)
    try {
      const created = await client().createCharacter(uploadOf(req.path), {
        name: req.name,
        autoRig: req.autoRig,
        frontFacing: req.frontFacing,
        rerigTarget: req.rerigTarget,
        includeFingers: req.includeFingers
      })
      if (stopped.has(id)) return
      const r = history().get(id)
      const world = r?.world
      let source = `local:${path.basename(req.path)}`
      if (world) {
        const root = project(world).path
        if (isSubPath(req.path, root)) source = path.relative(root, req.path).replace(/\\/g, '/')
      }
      const rec: UthanaCharacterRecord = {
        id: created.id,
        name: created.name,
        world,
        source,
        sha256: sha256File(req.path),
        autoRigConfidence: created.autoRigConfidence,
        rerigTarget: req.rerigTarget || undefined,
        message: created.message,
        runId: id,
        createdAt: nowIso()
      }
      // Uthana returns the first id again for a duplicate upload: keep one record per world
      writeJson(charactersFile(), [rec, ...readCharacters().filter((c) => !(c.id === rec.id && (c.world ?? null) === (world ?? null)))])
      set(id, { status: 'completed', character: rec, characterId: rec.id, characterName: rec.name, completedAt: nowIso() })
      bus.publish({ type: 'sfx', sound: 'ready' })
    } catch (e) {
      if (!stopped.has(id)) fail(id, errMsg(e))
    } finally {
      active.delete(id)
      stopped.delete(id)
    }
  }

  const newRun = (r: Omit<UthanaRun, 'id' | 'status' | 'files' | 'createdAt'>): UthanaRun => {
    const run: UthanaRun = { ...r, id: `uth-${Date.now().toString(36)}-${rid(2)}`, status: 'submitting', files: [], createdAt: nowIso() }
    history().add(run)
    bus.publish({ type: 'uthana-run', run })
    return run
  }

  const motionOf = (r: UthanaRun | undefined, motionId?: string): { run: UthanaRun; motionId: string } => {
    if (!r) throw new Error('No such run.')
    if (r.kind === 'character' || !r.motionId) throw new Error('This run has no motion yet.')
    const m = motionId ?? r.motionId
    if (!(r.motionIds ?? [r.motionId]).includes(m)) throw new Error('That motion is not part of this run.')
    return { run: r, motionId: m }
  }

  const svc: UthanaService = {
    runs: () => history().list(),

    world(world: string | null): UthanaWorldState {
      const month = monthKey()
      const keySet = Boolean(key())
      const falRuns = (() => {
        try {
          return getCtx().fal?.runs() ?? []
        } catch {
          return []
        }
      })()
      const all = readCharacters()
      if (!world) {
        const scratch = readJson<{ budget?: UthanaWorldState['budget'] }>(path.join(getCtx().main.home.data, 'fal', 'scratch-config.json'), {})
        return {
          world: null,
          keySet,
          config: {},
          folder: suggestAnimationFolder(undefined),
          characters: worldCharacters(all, null),
          budget: scratch.budget,
          spentUsd: uthanaWorldSpend([], falRuns, history().list(), null, month),
          month
        }
      }
      const p = project(world)
      const config = readUthanaConfig(p.path)
      return {
        world,
        keySet,
        config,
        folder: typeof config.folder === 'string' && config.folder.trim() ? config.folder : suggestAnimationFolder(p.engine, p.engineRoot),
        characters: worldCharacters(all, world),
        budget: readWorldConfig(p.path).budget,
        spentUsd: uthanaWorldSpend(readSpend(p.path), falRuns, history().list(), world, month),
        month,
        engine: p.engine
      }
    },

    saveWorldConfig(world: string | null, config: UthanaWorldConfig): UthanaWorldState {
      if (!world) throw new Error('Pick a world: Scratch has no save folder.')
      const p = project(world)
      const folder = String(config.folder ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '')
      if (folder) worldTarget(p.path, folder, 'probe') // refuses folders outside the world or in .git
      ensureGenioDir(p.path, p.engine)
      const next: UthanaWorldConfig = { ...readUthanaConfig(p.path), ...config, schema: 'genio.uthana-config.v1' }
      if (folder) next.folder = folder
      else delete next.folder
      writeJson(genioPath(p.path, 'uthana', 'config.json'), next)
      return svc.world(world)
    },

    account: (): Promise<UthanaAccount> => {
      requireKey()
      return client().account()
    },

    characters: (): Promise<UthanaRemoteCharacter[]> => {
      requireKey()
      return client().characters()
    },

    forgetCharacter(world: string | null, id: string): UthanaWorldState {
      writeJson(charactersFile(), readCharacters().filter((c) => !(c.id === id && (c.world ?? null) === world)))
      return svc.world(world)
    },

    inspect: (p: string, kind: 'character' | 'video', world: string | null): UthanaFileInfo => fileInfo(p, kind, world ? worldOf(world) ?? null : null),

    upload(req: UthanaUploadRequest): UthanaRun {
      requireKey()
      const world = worldOf(req.world)
      const info = fileInfo(req.path, 'character', world ?? null)
      const name = req.name.trim() || info.name.replace(/\.[^.]+$/, '')
      const est = estimateUthana('auto-rig', { autoRig: req.autoRig })
      const run = newRun({
        kind: 'character',
        model: 'auto-rig',
        input: {
          name,
          file: `@file:${req.path}`,
          auto_rig: req.autoRig ?? true,
          auto_rig_front_facing: req.frontFacing ?? true,
          include_fingers: req.includeFingers ?? true,
          ...(req.rerigTarget ? { rerig_target: req.rerigTarget } : {})
        },
        characterId: '',
        characterName: name,
        estUsd: est.usd,
        estUpTo: est.upTo,
        world
      })
      set(run.id, { status: 'running', startedAt: nowIso() })
      void driveUpload(run.id, { ...req, name })
      return history().get(run.id) ?? run
    },

    generate(req: UthanaGenerateRequest): UthanaRun {
      requireKey()
      const m = uthanaModel(req.model)
      if (!m || m.kind === 'character') throw new Error(`Not an Uthana motion model: ${req.model}`)
      if (!/^[A-Za-z0-9_-]+$/.test(req.characterId ?? '')) throw new Error('Pick a character.')
      const world = worldOf(req.world)
      let input: Record<string, unknown>
      let est
      if (m.kind === 'text') {
        if (!req.text) throw new Error('Describe the motion.')
        const text = textParamsFor(m.id, req.text)
        const errs = textParamErrors(m.id, text)
        const first = Object.entries(errs)[0]
        if (first) throw new Error(`${first[0]}: ${first[1]}`)
        req = { ...req, text }
        input = { ...text }
        est = estimateUthana(m.id, { length: text.length })
      } else {
        if (!req.video?.path) throw new Error('Pick a video.')
        const info = fileInfo(req.video.path, 'video', world ?? null)
        input = { video: `@file:${req.video.path}`, motion_name: req.video.motionName.trim() || info.name.replace(/\.[^.]+$/, ''), ...(info.seconds ? { video_seconds: +info.seconds.toFixed(2) } : {}) }
        est = estimateUthana(m.id, { seconds: info.seconds })
      }
      const run = newRun({
        kind: m.kind,
        model: m.id,
        input,
        characterId: req.characterId,
        characterName: req.characterName,
        motionName: m.kind === 'video' ? (input.motion_name as string) : undefined,
        estUsd: est.usd,
        estUpTo: est.upTo,
        world
      })
      const body: UthanaGenerateRequest = m.kind === 'text' ? req : { ...req, video: { path: req.video!.path, motionName: input.motion_name as string } }
      void drive(run.id, body)
      return run
    },

    cancel(id: string): OpResult {
      const r = history().get(id)
      if (!r) return { ok: false, message: 'No such run.' }
      if (!UTHANA_IN_FLIGHT.has(r.status)) return { ok: false, message: `This run is already ${r.status}.` }
      stopped.add(id)
      set(id, { status: 'cancelled', completedAt: nowIso(), error: 'Stopped waiting. Uthana has no cancel: the job may still finish (and bill) in your account at uthana.com/app.' })
      if (!active.has(id)) stopped.delete(id)
      return { ok: true, message: 'Stopped waiting for Uthana.' }
    },

    remove(id: string): OpResult {
      const r = history().get(id)
      if (!r) return { ok: false, message: 'No such run.' }
      if (UTHANA_IN_FLIGHT.has(r.status)) return { ok: false, message: 'Stop the run before deleting it.' }
      history().remove(id)
      return { ok: true, message: 'Run and its downloads deleted. Uthana keeps the motion in your account.' }
    },

    async preview(req: UthanaPreviewRequest): Promise<UthanaFile> {
      const { run, motionId } = motionOf(history().get(req.runId), req.motionId)
      const fileName = `preview-${req.source}-${motionId}.glb`
      const cached = run.files.find((f) => f.fileName === fileName)
      if (cached && exists(cached.localPath)) return cached
      requireKey()
      const url = req.source === 'skeleton' ? motionOnlyUrl(run.characterId, motionId, 30) : motionFileUrl(run.characterId, motionId, 'glb', { fps: 30 }, 'preview')
      return storeFile(run, fileName, url, { motionId, format: 'glb', options: req.source === 'skeleton' ? { fps: 30, noMesh: true } : { fps: 30 }, preview: req.source })
    },

    async fetchExport(req: UthanaExportRequest): Promise<{ run: UthanaRun; file: UthanaFile }> {
      const { run, motionId } = motionOf(history().get(req.runId), req.motionId)
      const problems = exportProblems(req.format, req.options)
      if (problems.length) throw new Error(problems.join(' '))
      const fileName = `export-${motionId}${optionsTag(req.options) ? `-${optionsTag(req.options)}` : ''}.${req.format}`
      const cached = run.files.find((f) => f.fileName === fileName)
      if (cached && exists(cached.localPath)) return { run, file: cached }
      requireKey()
      const stem = path.basename(safeFileName(req.fileName, 'motion'), path.extname(req.fileName))
      const file = await storeFile(run, fileName, motionFileUrl(run.characterId, motionId, req.format, req.options, stem), { motionId, format: req.format, options: req.options })
      return { run: history().get(run.id) ?? run, file }
    },

    async saveToWorld(req: UthanaExportRequest): Promise<UthanaExportResult> {
      if (!req.project) throw new Error('Pick a world.')
      const proj = project(req.project)
      const folder = req.folder ?? svc.world(proj.name).folder
      const target = worldTarget(proj.path, folder, req.fileName)
      const rel = path.relative(proj.path, target).replace(/\\/g, '/')
      if (exists(target) && !req.overwrite) return { ok: false, exists: true, path: target, message: `${rel} already exists in ${proj.name}.` }
      const { run, file } = await svc.fetchExport(req)
      ensureDir(path.dirname(target))
      fs.copyFileSync(file.localPath, target, req.overwrite ? 0 : fs.constants.COPYFILE_EXCL)

      // provenance + spend line next to the asset, left uncommitted like the asset itself
      const prov = provenanceInput(run.input, proj.path)
      const derived = [...prov.derivedFrom]
      const ch = readCharacters().find((c) => c.id === run.characterId && c.source)
      if (ch?.source && !derived.includes(ch.source)) derived.push(ch.source)
      const m = uthanaModel(run.model)
      const cost = runCost(run)
      const endpoint = `uthana/${run.model}`
      const provenance = writeProvenance(
        proj.path,
        {
          schema: 'genio.provenance.v1',
          path: rel,
          sha256: sha256File(target),
          provider: 'uthana',
          endpoint,
          request_id: file.motionId,
          input: {
            ...prov.input,
            character_id: run.characterId,
            ...(run.characterName ? { character_name: run.characterName } : {}),
            ...(run.jobId ? { job_id: run.jobId } : {}),
            download: { format: req.format, ...req.options }
          },
          price: { unit: m?.unit ?? null, unit_price_usd: m?.unitPrice ?? null, estimated_usd: cost ?? null, checked: UTHANA_PRICES_CHECKED },
          recipe: null,
          derived_from: derived,
          by: 'player',
          created: run.completedAt ?? run.createdAt
        },
        proj.engine
      )
      appendSpend(
        proj.path,
        { t: run.createdAt, provider: 'uthana', endpoint, request_id: uthanaRequestId(run), units: run.outputSeconds ?? null, unit: 'seconds', est_usd: cost ?? 0, by: 'player' },
        proj.engine
      )
      const warnings = [...exportWarnings(req.format, req.options, run.characterId), ...(await lfsWarnings(proj.path, rel))]
      return { ok: true, path: target, provenance, warnings, message: `Saved to ${proj.name}/${rel}` }
    },

    resume(): void {
      for (const r of history().list()) {
        if (!UTHANA_IN_FLIGHT.has(r.status)) continue
        if (r.jobId) void drive(r.id)
        else fail(r.id, 'Interrupted before Uthana answered (Genio restarted). The result may exist anyway: check uthana.com/app.')
      }
    },

    mediaPath(id: string, fileName: string): string | undefined {
      const p = history().filePath(id, fileName)
      return p && exists(p) ? p : undefined
    }
  }
  return svc
}
