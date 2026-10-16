/**
 * The Modeller's live view as main reads it from a unit's step data (the kernel's manifest.json, see
 * resources/unit-skills/genio/skills/blender/scripts/modeller.mjs): the model being built, the steps
 * on its current branch with their GLBs, the step Blender is running now and a failed last attempt.
 * Read only; the kernel owns these files and may rewrite them at any moment.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ModellerLive, ModellerStep } from '@shared/modeller'

interface Entry { id: string; n: number; parent: string | null; caption?: string; name?: string; t?: string; ms?: number; triangles?: number; objects?: number; warnings?: number; files?: { glb?: string | null; view?: string | null; receipt?: string | null } }
interface Failure { id: string; name?: string; branch?: string; kind?: string; error?: string; t?: string; dir?: string }
interface Manifest { model?: string; updated?: string; branch?: string; branches?: Record<string, { head: string | null }>; steps?: Entry[]; failures?: Failure[]; history?: { t?: string }[] }

const readJson = (file: string): unknown => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return undefined } }
const stepNumber = (id: string): number => Number(/^s(\d+)$/.exec(id)?.[1] ?? 0)
const alive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/** The first line of a Python script's docstring, as genio_step.py's caption_of reads it. */
export function scriptCaption(code: string): string | null {
  const m = /^(?:[ \t]*(?:#[^\n]*)?\r?\n)*[ \t]*[rRuU]?("""|'''|"|')([\s\S]*?)\1/.exec(code.replace(/^﻿/, ''))
  const first = m?.[2].split(/\r?\n/).map(s => s.trim()).find(Boolean)
  return first || null
}
const captionOf = (file: string): string | null => { try { return scriptCaption(fs.readFileSync(file, 'utf8')) } catch { return null } }

/** The unit's most recently updated model below `dataDir` (its modeller folder): its folder name and manifest. */
function latestModel(dataDir: string): { dir: string; m: Manifest } | undefined {
  let dirs: fs.Dirent[]
  try { dirs = fs.readdirSync(dataDir, { withFileTypes: true }) } catch { return undefined }
  let best: { dir: string; m: Manifest } | undefined
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const m = readJson(path.join(dataDir, d.name, 'manifest.json')) as Manifest | undefined
    if (!m || typeof m !== 'object' || !Array.isArray(m.steps)) continue
    if (!best || String(m.updated ?? '') > String(best.m.updated ?? '')) best = { dir: d.name, m }
  }
  return best
}

/** Whether the unit has started a model: what makes a Build a Modeller on the Squad. */
export const hasModellerModel = (dataDir: string): boolean => !!latestModel(dataDir)

/**
 * The live state of the unit's most recently updated model below `dataDir` (its modeller folder), or
 * null while it has none. `base` is the unit's viewer grant (genio-media://model/<token>/), asked for
 * only when there is a model; step GLBs and review renders are served below its `modeller/` root.
 */
export function readModellerLive(dataDir: string, base: () => string): ModellerLive | null {
  const best = latestModel(dataDir)
  if (!best) return null
  const { dir, m } = best
  const folder = path.join(dataDir, dir)
  const branch = typeof m.branch === 'string' ? m.branch : 'main'
  const byId = new Map(m.steps!.filter(s => s && typeof s.id === 'string').map(s => [s.id, s]))
  const line: Entry[] = []
  const seen = new Set<string>()
  for (let id = m.branches?.[branch]?.head ?? null; id && byId.has(id) && !seen.has(id); id = byId.get(id)!.parent) {
    seen.add(id)
    line.unshift(byId.get(id)!)
  }
  const root = base()
  const url = (rel: unknown): string | null => typeof rel === 'string' ? root + ['modeller', dir, ...rel.split('/')].map(encodeURIComponent).join('/') : null
  const steps: ModellerStep[] = line.map(s => ({
    id: s.id, n: Number(s.n) || stepNumber(s.id), caption: String(s.caption || s.name || s.id), triangles: Number(s.triangles) || 0,
    parts: Number(s.objects) || 0, warnings: Number(s.warnings) || 0, ms: Number(s.ms) || 0, glb: url(s.files?.glb), view: url(s.files?.view)
  }))
  const branches = Object.keys(m.branches && typeof m.branches === 'object' ? m.branches : {})
  if (!branches.includes(branch)) branches.unshift(branch)
  // The head step's advisory checks, as genio_step.py wrote them into its receipt.
  const headReceipt = line.at(-1)?.files?.receipt
  const receipt = typeof headReceipt === 'string' && /^steps\/s\d+\/receipt\.json$/.test(headReceipt) ? readJson(path.join(folder, ...headReceipt.split('/'))) as { warnings?: unknown } | undefined : undefined
  const checks = Array.isArray(receipt?.warnings) ? receipt.warnings.filter((w): w is string => typeof w === 'string').slice(0, 20) : []

  let running: ModellerLive['running'] = null
  const lock = Number((() => { try { return fs.readFileSync(path.join(folder, '.lock'), 'utf8') } catch { return '' } })())
  if (alive(lock)) {
    let pending: string | undefined
    try { pending = fs.readdirSync(path.join(folder, 'steps')).filter(n => /^\.pending-s\d+$/.test(n)).sort().pop() } catch { /* no steps yet */ }
    if (pending) {
      const id = pending.slice('.pending-'.length), p = path.join(folder, 'steps', pending)
      let startedAt = Date.now()
      try { const st = fs.statSync(p); startedAt = Math.round(st.birthtimeMs || st.ctimeMs) } catch { /* just finished */ }
      running = { id, n: stepNumber(id), caption: captionOf(path.join(p, 'script.py')) ?? id, startedAt }
    }
  }

  // A failure counts only when nothing moved the model since (a new step, a revert, a branch switch).
  const list = <T>(v: T[] | undefined): T[] => Array.isArray(v) ? v : []
  const moved = [line.at(-1)?.t, ...list(m.history).map(h => h?.t)].reduce<string>((a, t) => typeof t === 'string' && t > a ? t : a, '')
  const last = [...list(m.failures)].reverse().find(f => f && (f.branch ?? branch) === branch)
  const failure: ModellerLive['failure'] = last && typeof last.id === 'string' && String(last.t ?? '') > moved
    ? { id: last.id, n: stepNumber(last.id), caption: (last.dir && captionOf(path.join(folder, last.dir, 'script.py'))) || String(last.name ?? last.id), kind: String(last.kind ?? 'error'), error: String(last.error ?? '').slice(0, 2000) }
    : null

  const model = typeof m.model === 'string' ? m.model : dir
  const stamp = JSON.stringify([model, branch, branches, m.updated, steps.map(s => s.id), running?.id, failure?.id])
  return { model, branch, branches, steps, checks, running, failure, stamp }
}
