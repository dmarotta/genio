import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { expect, it, vi } from 'vitest'
import { modelViewerFiles } from '../../src/main/model-viewer'
import { collectResources, disposeResources } from '../../src/renderer/src/viewer3d/resources'
import { writeLargeModels } from '../helpers/large-model-fixtures'
import { report, summarise } from './measure'

it('streams and parses generated large FBX and separate-buffer glTF within the preview budget', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-perf-'))
  const timings: unknown[] = []
  try {
    const fixtures = writeLargeModels(root)
    const files = modelViewerFiles({ projectRoot: () => root, rendererDir: '' })
    // Three's FileLoader uses ProgressEvent even when no callback is installed.
    vi.stubGlobal('ProgressEvent', class { constructor(public type: string) {} })
    vi.stubGlobal('fetch', async (request: RequestInfo | URL) => files.handle(request instanceof Request ? request : new Request(String(request))))
    for (const [name, file] of Object.entries({ fbx: fixtures.fbx, gltf: fixtures.gltf })) {
      const url = await files.grant('fixture', path.basename(file))
      const beforeRead = performance.now()
      const response = await files.handle(new Request(url))
      expect(response.status).toBe(200)
      const bytes = await response.arrayBuffer(), beforeParse = performance.now()
      const scene = name === 'fbx' ? new FBXLoader().parse(bytes, '') : (await new GLTFLoader().parseAsync(bytes, url.slice(0, url.lastIndexOf('/') + 1))).scene
      const parsed = performance.now()
      let vertices = 0
      scene.traverse(o => { if ((o as THREE.Mesh).isMesh) vertices += (o as THREE.Mesh).geometry.attributes.position.count })
      expect(vertices).toBe(fixtures.vertices)
      expect(parsed - beforeRead).toBeLessThan(10_000)
      summarise(`viewer ${name} file+transfer`, [beforeParse - beforeRead], 'ms', `${fs.statSync(file).size} bytes; ${vertices} vertices`)
      summarise(`viewer ${name} parse`, [parsed - beforeParse], 'ms')
      timings.push({ format: name, bytes: fs.statSync(file).size, vertices, readMs: beforeParse - beforeRead, parseMs: parsed - beforeParse })
      disposeResources(collectResources(scene))
      files.revoke(url)
    }
    report()
    if (process.env.MODEL_VIEWER_PERF_RESULTS) fs.writeFileSync(process.env.MODEL_VIEWER_PERF_RESULTS, JSON.stringify(timings, null, 2))
  } finally { vi.unstubAllGlobals(); fs.rmSync(root, { recursive: true, force: true }) }
})
