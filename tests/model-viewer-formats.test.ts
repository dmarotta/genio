import fs from 'node:fs'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { decodeTga } from '../src/renderer/src/viewer3d/tga'
import { applyUnityClips, fbxFrameRate, unityClips } from '../src/renderer/src/viewer3d/unity-meta'
import { sideFileUrl } from '../src/renderer/src/viewer3d/formats'
import { crateGrid, tga, type Rgba } from './helpers/model-fixtures'

/** A copy in its own ArrayBuffer (a Node Buffer's slice still shares the pool). */
const buffer = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer
const fixture = (name: string): ArrayBuffer => buffer(fs.readFileSync(`tests/fixtures/models/${name}`))
/** Every pixel of a decoded image, top-down. */
const pixels = (img: { width: number; height: number; data: Uint8ClampedArray }): Rgba[] =>
  Array.from({ length: img.width * img.height }, (_, i) => [...img.data.subarray(i * 4, i * 4 + 4)] as Rgba)

describe('TGA decoding (runs in the viewer\'s texture worker)', () => {
  const pattern = (x: number, y: number): Rgba => [x * 40, y * 60, x === y ? 255 : 0, 128 + x]
  const expected = Array.from({ length: 12 }, (_, i) => pattern(i % 4, Math.floor(i / 4)))

  it('reads raw and RLE true colour in either row order, with and without alpha', () => {
    for (const rle of [false, true]) for (const topDown of [false, true]) {
      expect(pixels(decodeTga(buffer(tga(4, 3, pattern, { rle, topDown, bits: 32 }))))).toEqual(expected)
      expect(pixels(decodeTga(buffer(tga(4, 3, pattern, { rle, topDown }))))).toEqual(expected.map(([r, g, b]) => [r, g, b, 255]))
    }
  })

  it('reads the committed RLE crate texture, grey and colour-mapped images', () => {
    const crate = decodeTga(fixture('Textures/crate_grid.tga'))
    expect([crate.width, crate.height]).toEqual([32, 32])
    expect(pixels(crate)[0]).toEqual(crateGrid(0, 0))
    expect(pixels(crate)[9 * 32 + 9]).toEqual(crateGrid(9, 9))
    const grey = new Uint8Array([0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1, 0, 8, 0x20, 10, 200])
    expect(pixels(decodeTga(buffer(grey)))).toEqual([[10, 10, 10, 255], [200, 200, 200, 255]])
    // Two palette entries (24-bit BGR), two 8-bit indices.
    const mapped = new Uint8Array([0, 1, 1, 0, 0, 2, 0, 24, 0, 0, 0, 0, 2, 0, 1, 0, 8, 0x20, 255, 0, 0, 0, 0, 255, 1, 0])
    expect(pixels(decodeTga(buffer(mapped)))).toEqual([[255, 0, 0, 255], [0, 0, 255, 255]])
  })

  it('refuses what it cannot read instead of drawing garbage', () => {
    expect(() => decodeTga(new ArrayBuffer(4))).toThrow('too short')
    expect(() => decodeTga(buffer(new Uint8Array([0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 24, 0])))).toThrow('type 7')
    const cut = tga(8, 8, crateGrid).slice(0, 40)
    expect(() => decodeTga(buffer(cut))).toThrow('cut short')
    const rle = tga(8, 8, crateGrid, { rle: true })
    expect(() => decodeTga(buffer(rle.slice(0, rle.length - 3)))).toThrow('cut short')
  })
})

describe('Unity .meta clip names', () => {
  const meta = fs.readFileSync('tests/fixtures/models/robot_binary.fbx.meta', 'utf8')

  it('reads clipAnimations entries and ignores nested fields and what follows the list', () => {
    expect(unityClips(meta)).toEqual([
      { name: 'Wave', takeName: 'Wave', firstFrame: 0, lastFrame: 40 },
      { name: 'Bend', takeName: 'Bend', firstFrame: 0, lastFrame: 40 }
    ])
    const nested = [
      'ModelImporter:', '  animations:', '    clipAnimations:', '    - serializedVersion: 16', '      name: "Run: fast"', '      takeName: Armature|Run',
      '      firstFrame: 10', '      lastFrame: 20.5', '      maskSource: {instanceID: 0}', '      events:', '      - time: 0.5', '        name: Step', '      curves: []',
      '    - name: \'It\'\'s idle\'', '      takeName: Idle', '      firstFrame: 0', '      lastFrame: 30', '    isReadable: 0', '    name: NotAClip'
    ].join('\r\n')
    expect(unityClips(nested)).toEqual([
      { name: 'Run: fast', takeName: 'Armature|Run', firstFrame: 10, lastFrame: 20.5 },
      { name: 'It\'s idle', takeName: 'Idle', firstFrame: 0, lastFrame: 30 }
    ])
    expect(unityClips('ModelImporter:\n  animations:\n    clipAnimations: []\n')).toEqual([])
    expect(unityClips('fileFormatVersion: 2')).toEqual([])
  })

  it('renames whole takes, cuts frame ranges and matches Blender\'s "Armature|Action" take names', () => {
    const track = new THREE.NumberKeyframeTrack('.morphTargetInfluences[0]', [0, 0.5, 1, 1.5, 2], [0, 1, 2, 3, 4])
    const takes = [new THREE.AnimationClip('RobotRig|Wave', 2, [track]), new THREE.AnimationClip('RobotRig|Bend', 2, [track.clone()])]
    const clips = applyUnityClips(takes, [
      { name: 'Wave', takeName: 'Wave', firstFrame: 0, lastFrame: 20 },
      { name: 'Bend start', takeName: 'RobotRig|Bend', firstFrame: 0, lastFrame: 10 },
      { name: 'Gone', takeName: 'Jump', firstFrame: 0, lastFrame: 10 }
    ], 10)!
    expect(clips.map(c => [c.name, c.duration])).toEqual([['Wave', 2], ['Bend start', 1]])
    expect([...clips[1].tracks[0].times]).toEqual([0, 0.5, 1])
    expect(takes[0].name).toBe('RobotRig|Wave')
    expect(applyUnityClips(takes, [{ name: 'Jump', takeName: 'Jump', firstFrame: 0, lastFrame: 1 }], 30)).toBeUndefined()
  })

  it('reads the frame rate an FBX states, binary or ASCII', () => {
    expect(fbxFrameRate(fixture('robot_binary.fbx'))).toBe(24)
    expect(fbxFrameRate(fixture('crate_ascii.fbx'))).toBeUndefined()
    const ascii = (body: string): ArrayBuffer => buffer(new TextEncoder().encode(`; FBX 7.4.0 project file\nGlobalSettings:  {\n\tProperties70:  {\n${body}\n\t}\n}`))
    expect(fbxFrameRate(ascii('\t\tP: "TimeMode", "enum", "", "",6'))).toBe(30)
    expect(fbxFrameRate(ascii('\t\tP: "TimeMode", "enum", "", "",14\n\t\tP: "CustomFrameRate", "double", "Number", "",12.5'))).toBe(12.5)
  })
})

describe('side-file URLs', () => {
  const folder = 'genio-media://model/abc/'
  it('keeps relative paths, and reduces the artist\'s disk paths to the file name main looks for below the model', () => {
    expect(sideFileUrl(`${folder}Textures/crate grid.png`, folder)).toBe(`${folder}Textures/crate%20grid.png`)
    expect(sideFileUrl(`${folder}./textures/robot_checker.png`, folder)).toBe(`${folder}textures/robot_checker.png`)
    expect(sideFileUrl(`${folder}Textures\\wood.tga`, folder)).toBe(`${folder}Textures/wood.tga`)
    expect(sideFileUrl(`${folder}C:\\Users\\artist\\Maps\\wood.tga`, folder)).toBe(`${folder}wood.tga`)
    expect(sideFileUrl(`${folder}/Users/artist/wood.png`, folder)).toBe(`${folder}wood.png`)
    expect(sideFileUrl(`${folder}../Textures/wood.png`, folder)).toBe(`${folder}wood.png`)
    expect(sideFileUrl(`${folder}robot%20checker.png`, folder)).toBe(`${folder}robot%20checker.png`)
    expect(sideFileUrl('blob:null/1234', folder)).toBe('blob:null/1234')
  })
})
