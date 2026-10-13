import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { installPlayPackage } from '../src/main/play-package'
import { gunzipSync } from 'node:zlib'
let root: string, engine: string, manifest: string
beforeEach(() => { root=fs.mkdtempSync(path.join(os.tmpdir(),'genio-play-package-'));engine=path.join(root,'Nested');fs.mkdirSync(path.join(engine,'Packages'),{recursive:true});manifest=path.join(engine,'Packages/manifest.json');fs.writeFileSync(manifest,JSON.stringify({dependencies:{'co.play.bot':'file:existing','com.unity.pipeline':'0.8.0-exp.1'},scopedRegistries:[]})) })
afterEach(() => fs.rmSync(root,{recursive:true,force:true}))
it('installs a portable nested-root tarball idempotently and preserves Toolbox and lock files', () => {
  const lock=path.join(engine,'Packages/packages-lock.json');fs.writeFileSync(lock,'leave untouched')
  installPlayPackage(process.cwd(),root,engine);const before=fs.readFileSync(manifest,'utf8');installPlayPackage(process.cwd(),root,engine)
  expect(fs.readFileSync(manifest,'utf8')).toBe(before)
  const result=JSON.parse(before);expect(result.dependencies['com.genio.play']).toBe('file:../../.genio/unity/com.genio.play-0.1.0.tgz');expect(result.dependencies['co.play.bot']).toBe('file:existing')
  expect(fs.readFileSync(lock,'utf8')).toBe('leave untouched')
})
it('refuses another package reference, changed archive, and hard-linked manifests', () => {
  fs.writeFileSync(manifest,JSON.stringify({dependencies:{'com.genio.play':'file:custom'}}))
  expect(()=>installPlayPackage(process.cwd(),root,engine)).toThrow('different')
  fs.writeFileSync(manifest,JSON.stringify({dependencies:{}}));fs.linkSync(manifest,path.join(root,'manifest-link'))
  expect(()=>installPlayPackage(process.cwd(),root,engine)).toThrow('hardlink')
  expect(fs.existsSync(path.join(root,'.genio'))).toBe(false)
})
it('ships exactly the current package sources in the UPM archive', () => {
  const source=path.resolve('resources/unity/com.genio.play')
  const tar=gunzipSync(fs.readFileSync(path.resolve('resources/unity/com.genio.play-0.1.0.tgz')))
  const names: string[]=[]
  for (let offset=0;offset<tar.length && tar[offset];) {
    const header=tar.subarray(offset,offset+512)
    const name=header.subarray(0,100).toString().split('\0')[0]
    const size=parseInt(header.subarray(124,136).toString().replace(/\0/g,''),8)
    expect(name).toMatch(/^package\//)
    const relative=name.slice(8); names.push(relative)
    expect(tar.subarray(offset+512,offset+512+size)).toEqual(fs.readFileSync(path.join(source,relative)))
    offset+=512+Math.ceil(size/512)*512
  }
  const files: string[]=[]
  const walk=(dir: string, prefix='') => {for(const e of fs.readdirSync(dir,{withFileTypes:true})){const rel=prefix+e.name;if(e.isDirectory())walk(path.join(dir,e.name),rel+'/');else files.push(rel)}}
  walk(source);expect(names.sort()).toEqual(files.sort())
})
