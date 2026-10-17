import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// The GPU-stream spike ships inside com.genio.play, which Genio embeds in every player copy: it must stay inert there.
const pkg = path.resolve(__dirname, '../resources/unity/com.genio.play')
const DEFINE = 'GENIO_PLAY_GPU_SHARE'

const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)])

describe('com.genio.play experimental GPU share', () => {
  it('compiles only behind its own define', () => {
    const asmdef = JSON.parse(fs.readFileSync(path.join(pkg, 'Experimental/GpuShare/Genio.Play.GpuShare.asmdef'), 'utf8'))
    expect(asmdef.defineConstraints).toEqual([DEFINE])
    expect(asmdef.versionDefines ?? []).toEqual([])
  })
  it('is never switched on or referenced by the shipped assemblies', () => {
    for (const file of files(pkg).filter(f => /\.(cs|asmdef|json)$/.test(f) && !f.includes(`${path.sep}Experimental${path.sep}`))) {
      const text = fs.readFileSync(file, 'utf8')
      expect(text, file).not.toContain(DEFINE)
      expect(text, file).not.toContain('Genio.Play.GpuShare')
    }
  })
})
