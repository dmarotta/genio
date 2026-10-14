import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PlayPool } from '../resources/unit-skills/genio/skills/play/scripts/pool.mjs'
import { PlayService } from '../src/main/play'
import type { AppCtx } from '../src/main/services'

let root: string, world: string, data: string, pool: PlayPool
beforeEach(() => { root=fs.mkdtempSync(path.join(os.tmpdir(),'genio-play-pool-')); world=path.join(root,'world');data=path.join(root,'data');fs.mkdirSync(world);pool=new PlayPool(data,world) })
afterEach(() => fs.rmSync(root,{recursive:true,force:true}))
it('shares the cap and FIFO queue, fences takeover tokens and preserves a successor on late release', async () => {
  const other=new PlayPool(data,world)
  const a=await pool.acquire('unit:a'); expect(a).not.toBeNull()
  expect(await other.acquire('unit:b')).toBeNull(); expect(await pool.acquire('unit:c')).toBeNull()
  await pool.release(a!.id,a!.token)
  expect(await pool.acquire('unit:c')).toBeNull()
  const b=await other.acquire('unit:b'); expect(b?.id).toBe(1)
  const player=await pool.acquire('player',process.pid,1,true)
  await expect(other.check(1,b!.token)).rejects.toThrow('lost')
  await other.release(1,b!.token)
  expect(await pool.check(1,player!.token)).toBe(player!.root)
  expect((await pool.state()).slots[0].owner).toBe('player')
  await expect(pool.configure(0)).rejects.toThrow('1–8')
})
it('reclaims expired leases and prunes stale queues', async () => {
  await pool.configure(2); const a=await pool.acquire('a'); const b=await pool.acquire('b')
  const file=path.join(pool.dir,'state.json'), state=JSON.parse(fs.readFileSync(file,'utf8'))
  state.slots[0].lease.expires=0;state.queue=[{owner:'dead',pid:process.pid,expires:0}];fs.writeFileSync(file,JSON.stringify(state))
  const c=await pool.acquire('c');expect(c?.id).toBe(a?.id)
  await pool.release(b!.id,b!.token)
  expect((await pool.state()).queue).toEqual([])
})
it('lowers the cap below live leases without refusing: the extra slot drains, takes no lease, and retires on release', async () => {
  await pool.configure(2); const a=(await pool.acquire('a'))!; const b=(await pool.acquire('b'))!
  expect(b.id).toBe(2)
  expect(await pool.configure(1)).toEqual({ cap: 1, draining: [2] })
  let state=await pool.state()
  expect(state.cap).toBe(1)
  expect(state.slots.find(s=>s.id===2)).toMatchObject({ owner:'b', draining:true, retired:false })
  // The draining lease keeps working; nobody new lands on it, not even by preference or takeover.
  expect(await pool.check(2,b.token)).toBe(b.root)
  await expect(pool.acquire('c',process.pid,2,true)).rejects.toThrow('above the cap')
  await pool.release(a.id,a.token)
  expect((await pool.acquire('c'))?.id).toBe(1)
  expect(await pool.acquire('d')).toBeNull()
  await pool.release(2,b.token)
  state=await pool.state()
  expect(state.slots.find(s=>s.id===2)).toMatchObject({ draining:false, retired:true })
  expect(await pool.acquire('d')).toBeNull()
  expect(state.queue).toEqual(['d'])
})
it('raising the cap lets queued requests proceed, reusing a retired slot', async () => {
  await pool.configure(2); const a=(await pool.acquire('a'))!; const b=(await pool.acquire('b'))!
  await pool.configure(1); await pool.release(b.id,b.token)
  expect(await pool.acquire('c')).toBeNull(); expect(await pool.acquire('d')).toBeNull()
  expect((await pool.state()).queue).toEqual(['c','d'])
  await pool.configure(3)
  const c=await pool.acquire('c'), d=await pool.acquire('d')
  expect(c?.id).toBe(2); expect(d?.id).toBe(3)
  const state=await pool.state()
  expect(state.queue).toEqual([]); expect(state.slots.every(s=>!s.draining&&!s.retired)).toBe(true)
  expect(a.id).toBe(1)
})
it('marks a slot above the cap draining while only its editor is still running', async () => {
  await pool.configure(2); await pool.acquire('a'); const b=(await pool.acquire('b'))!
  await pool.release(b.id,b.token)
  // An editor still open in the idle slot (one Genio did not launch).
  fs.mkdirSync(path.join(b.root,'Temp'),{recursive:true}); fs.writeFileSync(path.join(b.root,'Temp/UnityLockfile'),'')
  expect(await pool.configure(1)).toEqual({ cap: 1, draining: [2] })
  expect((await pool.state()).slots.find(s=>s.id===2)).toMatchObject({ editor:true, draining:true })
  expect(fs.existsSync(path.join(b.root,'Temp/UnityLockfile'))).toBe(true) // never closed by a cap change
})
it('reports disk used per existing slot copy', async () => {
  const a=(await pool.acquire('a'))!
  fs.mkdirSync(path.join(a.root,'Library'),{recursive:true}); fs.writeFileSync(path.join(a.root,'Library/cache'),'12345')
  expect(await pool.disk()).toEqual({ 1: 5 })
})
it('allocates at most one lease across separate Node processes', async () => {
  const module=pathToFileURL(path.resolve('resources/unit-skills/genio/skills/play/scripts/pool.mjs')).href
  const script=`import {PlayPool} from ${JSON.stringify(module)}; const p=new PlayPool(process.argv[1],process.argv[2]); console.log(JSON.stringify(await p.acquire(process.argv[3]))); setInterval(()=>{},1000);`
  const children=Array.from({length:3},(_,i)=>spawn(process.execPath,['--no-warnings','--input-type=module','-e',script,data,world,`unit:${i}`],{windowsHide:true,stdio:['ignore','pipe','pipe']}))
  try {
    const results=await Promise.all(children.map(c=>new Promise<unknown>((resolve,reject)=>{let out='';c.stdout.on('data',b=>{out+=b;if(out.includes('\n')) resolve(JSON.parse(out.trim()))});c.once('error',reject);c.stderr.on('data',b=>reject(new Error(String(b))))})))
    expect(results.filter(Boolean)).toHaveLength(1)
  } finally { await Promise.all(children.map(c=>new Promise<void>(r=>{c.once('exit',()=>r());c.kill()}))) }
})
it('configures the cap through the service, unlocking the achievement even below live leases', async () => {
  const unlock=vi.fn()
  const svc=new PlayService({ projects:{ get:()=>({ path:world, engine:'unity' }) }, main:{ home:{ data } }, stats:{ unlock } } as unknown as AppCtx)
  await svc.configurePool('game',2); await pool.acquire('a'); await pool.acquire('b')
  await expect(svc.configurePool('game',1)).resolves.toEqual({ cap:1, draining:[2] })
  expect(unlock).toHaveBeenCalledWith('play-pool-configured')
})
function git(cwd: string, args: string[]) { return execFileSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_CONFIG_COUNT:'0'}}).trim() }
it('copies only a committed revision, seeds Library without credentials, clears a crashed editor lock and protects dirty slots', async () => {
  git(world,['init','-q']);git(world,['config','user.name','Test']);git(world,['config','user.email','test@example.invalid'])
  fs.mkdirSync(path.join(world,'Assets'));fs.writeFileSync(path.join(world,'Assets/game.txt'),'v1');fs.writeFileSync(path.join(world,'.gitignore'),'Library/\nTemp/\n')
  git(world,['add','.']);git(world,['commit','-qm','first'])
  fs.mkdirSync(path.join(world,'Library/Pipeline'),{recursive:true});fs.writeFileSync(path.join(world,'Library/Pipeline/.unity-pipeline-port'),'secret');fs.writeFileSync(path.join(world,'Library/warm'),'cache')
  fs.writeFileSync(path.join(world,'uncommitted.txt'),'never copy')
  const a=(await pool.acquire('a'))!;await pool.prepare(a.id,a.token)
  expect(fs.readFileSync(path.join(a.root,'Assets/game.txt'),'utf8')).toBe('v1')
  expect(fs.existsSync(path.join(a.root,'uncommitted.txt'))).toBe(false)
  expect(fs.existsSync(path.join(a.root,'Library/Pipeline'))).toBe(false)
  expect(fs.readFileSync(path.join(a.root,'Library/warm'),'utf8')).toBe('cache')
  fs.writeFileSync(path.join(world,'Assets/game.txt'),'v2');git(world,['add','Assets']);git(world,['commit','-qm','second'])
  // A crashed editor leaves its lockfile and no live process: switching clears it instead of refusing.
  fs.mkdirSync(path.join(a.root,'Temp'));fs.writeFileSync(path.join(a.root,'Temp/UnityLockfile'),'')
  await pool.prepare(a.id,a.token)
  expect(fs.readFileSync(path.join(a.root,'Assets/game.txt'),'utf8')).toBe('v2')
  expect(fs.existsSync(path.join(a.root,'Temp/UnityLockfile'))).toBe(false)
  fs.writeFileSync(path.join(world,'Assets/game.txt'),'v3');git(world,['add','Assets']);git(world,['commit','-qm','third'])
  fs.writeFileSync(path.join(a.root,'Assets/game.txt'),'local')
  await expect(pool.prepare(a.id,a.token)).rejects.toThrow('local changes')
  expect(fs.readFileSync(path.join(a.root,'Assets/game.txt'),'utf8')).toBe('local')
}, 30000)
it('refuses links in Unity trees before an editor can import outside its slot', async () => {
  const lease=(await pool.acquire('a'))!
  fs.mkdirSync(path.join(lease.root,'Assets'),{recursive:true})
  const external=path.join(root,'external');fs.mkdirSync(external)
  fs.symlinkSync(external,path.join(lease.root,'Assets','outside'),process.platform==='win32'?'junction':'dir')
  await expect(pool.validateCopy(lease.id)).rejects.toThrow('links')
})
