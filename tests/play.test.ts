import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { UnityAdapter, pipelineRequest } from '../src/main/play-unity'
import { assertProjectWindow, PlayService } from '../src/main/play'
import type { AppCtx } from '../src/main/services'

let root: string; let server: http.Server; let port: number
let dirty: boolean; let token: string; let requests: { command: string; parameters: Record<string, unknown>; auth?: string; host?: string }[]
let mode: string; let redirect: boolean
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII='
function descriptor(patch: object = {}) {
  fs.writeFileSync(path.join(root, 'Library/Pipeline/.unity-pipeline-port'), JSON.stringify({ projectPath: root, port, pid: process.pid, mode: 'editor', lastHeartbeat: new Date().toISOString(), evalToken: token, ...patch }))
}
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-play-'))
  fs.mkdirSync(path.join(root, 'Library/Pipeline'), { recursive: true })
  dirty = false; token = 'test-token-private'; requests = []; mode = 'stopped'; redirect = false
  server = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c)
    req.on('end', () => {
      if (redirect) { res.writeHead(302, { Location: 'http://example.com/secret' }); res.end(); return }
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return }
      const body = JSON.parse(raw)
      requests.push({ ...body, auth: req.headers.authorization, host: req.headers.host })
      let result: unknown
      switch (body.command) {
        case 'editor_status': result = { projectPath: root, playMode: mode, compiling: false, domainReloadInProgress: false }; break
        case 'list_open_scenes': result = { scenes: [{ name: 'Game', path: 'Assets/Game.unity', isDirty: dirty, isActive: true }] }; break
        case 'editor_play': mode = 'playing'; result = 'Entered play mode'; break
        case 'editor_stop': mode = 'stopped'; result = 'Stopped'; break
        case 'capture_game_view': result = { base64: png, width: 1, height: 1 }; break
        case 'eval': result = { success: true, result: { x: 1920, y: 1080 } }; break
        default: result = { success: true }
      }
      res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ success: true, result }))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  port = (server.address() as { port: number }).port
  descriptor()
})
afterEach(async () => {
  await new Promise<void>(r => server.close(() => r()))
  fs.rmSync(root, { recursive: true, force: true })
})
it('authenticates only on IPv4 loopback and does not expose token in status or frames', async () => {
  const adapter = new UnityAdapter(root)
  expect((await adapter.status()).connected).toBe(true)
  const frame = await adapter.frame(640,360)
  expect(frame.base64).toBe(png)
  expect(JSON.stringify(frame)).not.toContain(token)
  expect(requests.every(r => r.host === `127.0.0.1:${port}` && r.auth === `Bearer ${token}`)).toBe(true)
  token = 'rotated-token'; descriptor()
  expect((await adapter.status()).connected).toBe(true)
  expect(JSON.stringify(await adapter.status())).not.toContain(token)
})
it.each([{ host:'0.0.0.0' }, { host:'example.com' }, { projectPath: 'C:/wrong-world' }, { mode:'batchmode' }, { pid:-1 }])('refuses wrong target metadata %j', async patch => {
  descriptor(patch)
  const s = await new UnityAdapter(root).status()
  expect(s.connected).toBe(false); expect(requests).toHaveLength(0)
})
it('does not follow HTTP redirects with the per-editor token', async () => {
  redirect = true
  await expect(pipelineRequest(port, token, 'editor_status')).rejects.toThrow('HTTP 302')
})
it('refuses entering play or changing a dirty scene without saving anything', async () => {
  dirty = true
  const adapter = new UnityAdapter(root)
  await expect(adapter.act({ type:'play' })).rejects.toThrow('Unsaved scenes')
  await expect(adapter.act({ type:'scene', path:'Assets/Game.unity' })).rejects.toThrow('Unsaved scenes')
  expect(requests.some(r => /^(save.*|editor_play|open_scene)$/.test(r.command))).toBe(false)
})
it('serializes the safety preflight and control and maps normalized clicks to render pixels', async () => {
  const adapter = new UnityAdapter(root)
  await adapter.act({type:'play'})
  await adapter.act({type:'pointer',x:0.25,y:0.75})
  expect(requests.at(-1)).toMatchObject({command:'simulate_pointer',parameters:{x:480,y:270,action:'click'}})
  await expect(adapter.act({type:'scene',path:'Assets/Game.unity'})).rejects.toThrow('Stop Play')
  await expect(adapter.act({type:'pointer',x:2,y:0})).rejects.toThrow('normalized')
})
it('binds Unity slots to the owning project window and gates Genio actions on player words', async () => {
  expect(() => assertProjectWindow(undefined, 'game')).toThrow('bound')
  expect(() => assertProjectWindow({project:'game'}, 'other')).toThrow('bound')
  expect(() => assertProjectWindow({project:'game'}, 'game')).not.toThrow()
  const svc = new PlayService({} as AppCtx)
  await expect(svc.act('game', {type:'play'}, ' ')).rejects.toThrow('player_words')
})
it('drives the main editor for Genio under the main lease, with no stream, step or resolution commands', async () => {
  const data = path.join(root, 'genio-data')
  const unlocked: string[] = []
  const ctx = { projects: { get: () => ({ path: root, engine: 'unity' }) }, main: { home: { data } }, stats: { unlock: (id: string) => unlocked.push(id) } } as unknown as AppCtx
  const svc = new PlayService(ctx)
  await svc.act('game', { type: 'play' }, 'press play')
  expect((await svc.status('game')).state).toBe('playing')
  expect((await svc.frame('game', 64, 36)).base64).toBe(png)
  expect(unlocked).toEqual(['play-first', 'play-observed'])
  expect(JSON.parse(fs.readFileSync(path.join(svc.pool('game').dir, 'state.json'), 'utf8')).main.pid).toBe(process.pid)
  await expect(svc.act('game', { type: 'step' } as never, 'step')).rejects.toThrow('Unknown Play action')
  expect(requests.some(r => /^genio_/.test(r.command))).toBe(false)
})
