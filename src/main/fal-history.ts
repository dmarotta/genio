/**
 * FAL run history: data/fal/runs.json (newest first, capped) plus each run's
 * downloaded outputs under data/fal/runs/<id>/. Inputs are trimmed before they
 * are stored so inline images (data URIs) don't bloat the file. Never holds the key.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { FalRun } from '@shared/api'
import { trimForHistory } from './fal'
import { isSubPath, readJson, writeJson } from './util'

export const IN_FLIGHT: ReadonlySet<FalRun['status']> = new Set(['submitting', 'queued', 'running'])

export class FalHistory {
  readonly file: string
  readonly runsDir: string

  constructor(
    readonly dir: string,
    private readonly max = 200
  ) {
    this.file = path.join(dir, 'runs.json')
    this.runsDir = path.join(dir, 'runs')
  }

  private read(): FalRun[] {
    const v = readJson<unknown>(this.file, [])
    return Array.isArray(v) ? (v as FalRun[]).filter((r) => r && typeof r.id === 'string') : []
  }

  private write(list: FalRun[]): void {
    writeJson(this.file, list)
  }

  list(): FalRun[] {
    return this.read()
  }

  get(id: string): FalRun | undefined {
    return this.read().find((r) => r.id === id)
  }

  inFlight(): FalRun[] {
    return this.read().filter((r) => IN_FLIGHT.has(r.status))
  }

  add(run: FalRun): FalRun {
    const rec: FalRun = { ...run, input: trimForHistory(run.input) as Record<string, unknown> }
    const list = [rec, ...this.read().filter((r) => r.id !== run.id)]
    // evict the oldest finished runs over the cap (never one still in flight)
    while (list.length > this.max) {
      const i = list.map((r) => IN_FLIGHT.has(r.status)).lastIndexOf(false)
      if (i <= 0) break
      this.dropFiles(list[i].id)
      list.splice(i, 1)
    }
    this.write(list)
    return rec
  }

  update(id: string, patch: Partial<FalRun>): FalRun | undefined {
    const list = this.read()
    const i = list.findIndex((r) => r.id === id)
    if (i < 0) return undefined
    const next: FalRun = { ...list[i], ...patch, id }
    if (patch.input) next.input = trimForHistory(patch.input) as Record<string, unknown>
    if (patch.result !== undefined) next.result = trimForHistory(patch.result)
    list[i] = next
    this.write(list)
    return next
  }

  remove(id: string): boolean {
    const list = this.read()
    const next = list.filter((r) => r.id !== id)
    if (next.length === list.length) return false
    this.write(next)
    this.dropFiles(id)
    return true
  }

  runDir(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error(`bad run id: ${id}`)
    return path.join(this.runsDir, id)
  }

  /** Absolute path of a run's file, or undefined if it escapes the run folder. */
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
