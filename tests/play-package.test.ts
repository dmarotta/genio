import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { installPlayPackage } from '../src/main/play-package'
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
