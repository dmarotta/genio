import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { PlayPool } from '../resources/unit-skills/genio/skills/play/scripts/pool.mjs'

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
it('reclaims expired leases, prunes stale queues, and refuses cap reduction across live leases', async () => {
  await pool.configure(2); const a=await pool.acquire('a'); const b=await pool.acquire('b')
  await expect(pool.configure(1)).rejects.toThrow('Release')
  const file=path.join(pool.dir,'state.json'), state=JSON.parse(fs.readFileSync(file,'utf8'))
  state.slots[0].lease.expires=0;state.queue=[{owner:'dead',pid:process.pid,expires:0}];fs.writeFileSync(file,JSON.stringify(state))
  const c=await pool.acquire('c');expect(c?.id).toBe(a?.id)
  await pool.release(b!.id,b!.token); await pool.configure(1)
  expect((await pool.state()).queue).toEqual([])
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
function git(cwd: string, args: string[]) { return execFileSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_CONFIG_COUNT:'0'}}).trim() }
it('copies only a committed revision, seeds Library without credentials, and protects dirty or open slots', async () => {
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
  fs.mkdirSync(path.join(a.root,'Temp'));fs.writeFileSync(path.join(a.root,'Temp/UnityLockfile'),'')
  await expect(pool.prepare(a.id,a.token)).rejects.toThrow('Close')
  fs.unlinkSync(path.join(a.root,'Temp/UnityLockfile'));fs.writeFileSync(path.join(a.root,'Assets/game.txt'),'local')
  await expect(pool.prepare(a.id,a.token)).rejects.toThrow('local changes')
  expect(fs.readFileSync(path.join(a.root,'Assets/game.txt'),'utf8')).toBe('local')
})
it('refuses links in Unity trees before an editor can import outside its slot', async () => {
  const lease=(await pool.acquire('a'))!
  fs.mkdirSync(path.join(lease.root,'Assets'),{recursive:true})
  const external=path.join(root,'external');fs.mkdirSync(external)
  fs.symlinkSync(external,path.join(lease.root,'Assets','outside'),process.platform==='win32'?'junction':'dir')
  await expect(pool.validateCopy(lease.id)).rejects.toThrow('links')
})
