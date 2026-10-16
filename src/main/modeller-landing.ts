/**
 * How a Modeller lands (Modeller build 4): the project paths it claims, the information report the
 * Gauntlet shows in place of checks, and what is left of its step data once it is despawned.
 * Step data is the kernel's (resources/unit-skills/genio/skills/blender/scripts/modeller.mjs).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { StatusEvent } from '@shared/types'
import { modelScriptsDir, normalizeClaim } from '@shared/modeller'
import { readModellerLive } from './modeller-live'

const readJson = (file: string): unknown => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return undefined } }

/** The models a unit has started: the folders below its modeller data dir that hold a manifest. */
export function modelNames(dataDir: string): string[] {
  let dirs: fs.Dirent[]
  try { dirs = fs.readdirSync(dataDir, { withFileTypes: true }) } catch { return [] }
  return dirs.filter(d => d.isDirectory() && fs.existsSync(path.join(dataDir, d.name, 'manifest.json'))).map(d => d.name).sort()
}

/**
 * A Modeller's claims: the paths it was deployed with, each model's build-script folder, and every
 * `note [key=claim]: <path>` it appended before writing an export or a .blend. Deduplicated, in order.
 */
export function unitClaims(spawn: string[] | undefined, dataDir: string, events: StatusEvent[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (p: string): void => {
    const c = p.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '')
    const k = normalizeClaim(c)
    if (!k || k.startsWith('/') || /^[a-z]:/i.test(k) || k.split('/').includes('..') || seen.has(k)) return
    seen.add(k)
    out.push(c)
  }
  for (const p of spawn ?? []) add(p)
  for (const m of modelNames(dataDir)) add(modelScriptsDir(m))
  for (const e of events) if (e.kind === 'note' && e.key === 'claim') for (const p of e.text.split(/[\s,]+/)) if (p) add(p.replace(/^`|`$/g, ''))
  return out
}

/** What the Gauntlet shows for a Modeller instead of running checks: the head step's counts and advisory checks. */
export function modellerReport(dataDir: string): string {
  const live = readModellerLive(dataDir, () => '')
  const head = live?.steps.at(-1)
  const lines = ["No checks for Modellers (the player's choice): this report is information only, and merging follows the usual approval."]
  if (!live || !head) return [...lines, 'No model step found in the unit\'s data.'].join('\n')
  lines.push(`Model ${live.model}, branch ${live.branch}: step ${head.n} "${head.caption}", ${head.triangles} triangles, ${head.parts} parts.`)
  lines.push(live.checks.length ? `Advisory checks (information only):\n${live.checks.map(c => `- ${c}`).join('\n')}` : 'Advisory checks: none raised.')
  return lines.join('\n')
}

interface StepFiles { blend?: string | null; glb?: string | null }
interface Manifest { steps?: { id?: string; files?: StepFiles; blend_sha256?: string | null }[] }

/**
 * Step-data retention on despawn: delete every step's .blend snapshot and GLB and any staging
 * folder, and keep the manifests, review renders, receipts and scripts
 * (about 1 MB a model) as history. The manifests stop pointing at what was deleted.
 */
export function pruneModellerData(dataDir: string): { files: number; bytes: number } {
  let files = 0, bytes = 0
  const drop = (p: string): void => {
    try {
      const st = fs.statSync(p)
      fs.rmSync(p, { recursive: true, force: true })
      files++
      bytes += st.isFile() ? st.size : 0
    } catch { /* already gone */ }
  }
  for (const model of modelNames(dataDir)) {
    const dir = path.join(dataDir, model)
    const file = path.join(dir, 'manifest.json')
    const m = readJson(file) as Manifest | undefined
    let stepDirs: string[] = []
    try { stepDirs = fs.readdirSync(path.join(dir, 'steps')) } catch { /* no steps */ }
    for (const s of stepDirs) {
      const p = path.join(dir, 'steps', s)
      if (s.startsWith('.pending-')) { drop(p); continue }
      for (const f of ['model.blend', 'model.glb']) drop(path.join(p, f))
    }
    if (m && Array.isArray(m.steps)) {
      for (const s of m.steps) {
        if (!s?.files) continue
        s.files.blend = null
        s.files.glb = null
        if ('blend_sha256' in s) s.blend_sha256 = null
      }
      try { fs.writeFileSync(file, JSON.stringify(m, null, 1)) } catch { /* history stays readable as it was */ }
    }
  }
  return { files, bytes }
}
