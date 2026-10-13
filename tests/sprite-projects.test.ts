import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exportSprites, pngBytes, safeSpriteTarget, SpriteProjects, validateProject } from '../src/main/sprite-projects'
import type { Project } from '../src/shared/types'
import type { FalRun } from '../src/shared/api'
import { fixture, png } from './sprite-fixtures'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-sprites-')) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
describe('sprite projects and export files', () => {
  it('persists sources, settings, edits, frames and provenance across service restarts per world', () => {
    const p = fixture(); p.frames.reverse(); p.settings.playback = 'ping-pong'; p.runIds = ['fal-1']
    const saved = new SpriteProjects(dir).save(p)
    const reopened = new SpriteProjects(dir).list('garden')
    expect(reopened).toEqual([saved]); expect(reopened[0].source).toBe(p.source)
    expect(new SpriteProjects(dir).list(null)).toEqual([])
    expect(new SpriteProjects(dir).list('another')).toEqual([])
    const scratch = { ...p, world: null }; new SpriteProjects(dir).save(scratch)
    expect(new SpriteProjects(dir).list(null)).toHaveLength(1)
  })
  it('rejects traversal, duplicate frame IDs, invalid counts, bad PNGs and palette values', () => {
    expect(() => new SpriteProjects(dir).save({ ...fixture(), id: '../escape' })).toThrow()
    const p = fixture(); p.frames.push(p.frames[0]); expect(() => validateProject(p)).toThrow(/unique/)
    p.frames.pop(); p.settings.count = 100; expect(() => validateProject(p)).toThrow()
    expect(() => pngBytes('data:image/png;base64,aGVsbG8=')).toThrow(/PNG/)
    expect(() => safeSpriteTarget(dir, '../escape.png')).toThrow()
    expect(() => safeSpriteTarget(dir, '.git/config')).toThrow()
    const palette = fixture(); palette.settings.palette = 'red'; expect(() => validateProject(palette)).toThrow(/hex/)
  })
  it('exports PNG, JSON, Unity slices and optional individual frames; protects all existing files', () => {
    const p = fixture(), req = { project: p, sheet: png(), individual: true, unity: true }
    const result = exportSprites(req, dir)
    expect(result.ok).toBe(true); expect(result.paths.map(p => path.basename(p))).toEqual(['fox.png', 'fox.json', 'fox-000.png'])
    expect(fs.readFileSync(path.join(dir, 'fox.png'))).toEqual(pngBytes(png()))
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'fox.json'), 'utf8'))
    expect(meta.schema).toBe('genio.sprite-sheet.v1'); expect(meta.unity.sprites[0].rect).toEqual({ x: 0, y: 0, width: 8, height: 8 })
    expect(exportSprites(req, dir).exists).toBe(true)
    expect(exportSprites({ ...req, overwrite: true }, dir).ok).toBe(true)
  })
  it('preflights conflicts before writing any other output', () => {
    fs.writeFileSync(path.join(dir, 'fox.json'), 'keep')
    expect(exportSprites({ project: fixture(), sheet: png(), individual: false, unity: false }, dir).exists).toBe(true)
    expect(fs.existsSync(path.join(dir, 'fox.png'))).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'fox.json'), 'utf8')).toBe('keep')
  })
  it('writes world-configured sprites with provenance and deduplicated spend, without git operations', () => {
    fs.mkdirSync(path.join(dir, '.genio', 'fal'), { recursive: true })
    const config = JSON.stringify({ folders: { sprite: 'Assets/Sprites', image: 'Assets/Images' } })
    fs.writeFileSync(path.join(dir, '.genio', 'fal', 'config.json'), config)
    const p = fixture(); p.runIds = ['run-1']
    const world = { name: 'garden', path: dir, engine: 'unity' } as Project
    const run = { id: 'run-1', world: 'garden', endpoint: 'fal-ai/birefnet/v2', requestId: 'request-1', estUsd: .0024, createdAt: '2026-10-13T00:00:00Z' } as FalRun
    const req = { project: p, sheet: png(), individual: false, unity: true }
    const result = exportSprites(req, dir, world, [run]); expect(result.ok).toBe(true)
    const prov = JSON.parse(fs.readFileSync(path.join(dir, '.genio', 'provenance', 'Assets', 'Sprites', 'fox.png.json'), 'utf8'))
    expect(prov.provider).toBe('fal'); expect(prov.input.runs[0].request_id).toBe('request-1'); expect(prov.sha256).toMatch(/^[a-f0-9]{64}$/)
    exportSprites({ ...req, overwrite: true }, dir, world, [run])
    expect(fs.readFileSync(path.join(dir, '.genio', 'spend.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
    expect(fs.readFileSync(path.join(dir, '.genio', 'fal', 'config.json'), 'utf8')).toBe(config)
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(false)
  })
  it('uses the image folder fallback and records local/Codex provenance without FAL spend', () => {
    fs.mkdirSync(path.join(dir, '.genio', 'fal'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.genio', 'fal', 'config.json'), JSON.stringify({ folders: { image: 'Art' } }))
    const p = fixture(); p.generations = [{ prompt: 'Draw fox', created: 'now', sha256: 'abc' }]
    exportSprites({ project: p, sheet: png(), individual: false, unity: false }, dir, { name: 'garden', path: dir } as Project)
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.genio', 'provenance', 'Art', 'fox.png.json'), 'utf8')).provider).toBe('codex')
    expect(fs.existsSync(path.join(dir, '.genio', 'spend.jsonl'))).toBe(false)
  })
  it('rejects mismatched sheet dimensions', () => {
    expect(() => exportSprites({ project: fixture(), sheet: png(9, 8), individual: false, unity: false }, dir)).toThrow(/dimensions/)
  })
  it('refuses oversized animation plans before generation and world assets inside .genio', () => {
    const p = fixture(); p.settings.count = 16; p.settings.directions = 8; p.settings.width = p.settings.height = 1024
    expect(() => validateProject(p)).toThrow(/32 megapixels/)
    fs.mkdirSync(path.join(dir, '.genio', 'fal'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.genio', 'fal', 'config.json'), JSON.stringify({ folders: { sprite: './.GENIO/assets' } }))
    expect(() => exportSprites({ project: fixture(), sheet: png(), individual: false, unity: false }, dir, { name: 'garden', path: dir } as Project)).toThrow(/inside .genio/)
  })
})
