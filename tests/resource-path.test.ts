import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { build } from 'electron-vite'
import { pluginFile, pluginRoots } from '../resources/unit-skills/genio/lib/resource-path.mjs'
import { helperSource } from '../resources/unit-skills/genio/lib/hidden-desktop.mjs'

const repo = path.resolve(__dirname, '..')
const plugin = path.join(repo, 'resources', 'unit-skills', 'genio')
const HELPER = 'lib/hidden-desktop/GenioDesktop.cs'
let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-resource-path-')) })
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

/** A file at `rel` under `dir`, creating its folders. */
function touch(dir: string, rel: string): string {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '// helper')
  return file
}

describe('pluginFile', () => {
  it('finds a file beside the module when run from the plugin (checkout or a unit\'s installed copy)', () => {
    expect(pluginFile(HELPER)).toBe(path.join(plugin, HELPER))
    expect(helperSource()).toBe(path.join(plugin, HELPER))
    const installed = path.join(root, 'plugins', 'genio'), copy = touch(installed, HELPER)
    expect(pluginFile(HELPER, { here: path.join(installed, 'lib') })).toBe(copy)
  })

  it('finds the checkout\'s resources from a module bundled into out/main in dev', () => {
    const app = path.join(root, 'checkout'), file = touch(app, `resources/unit-skills/genio/${HELPER}`)
    expect(pluginFile(HELPER, { here: path.join(app, 'out', 'main') })).toBe(file)
  })

  it('finds the shipped resources in a packaged build, also from a relocated bundle', () => {
    const resources = path.join(root, 'Genio', 'resources')
    const file = touch(path.join(resources, 'app'), `resources/unit-skills/genio/${HELPER}`)
    expect(pluginFile(HELPER, { here: path.join(resources, 'app', 'out', 'main'), resourcesPath: resources })).toBe(file)
    expect(pluginFile(HELPER, { here: path.join(root, 'elsewhere', 'main'), resourcesPath: resources })).toBe(file)
  })

  it('names the missing file and every place it looked', () => {
    const here = path.join(root, 'app', 'out', 'main'), resourcesPath = path.join(root, 'resources')
    const tried = pluginRoots({ here, resourcesPath }).map(r => path.join(r, HELPER))
    expect(tried).toHaveLength(3)
    expect(() => pluginFile(HELPER, { here, resourcesPath })).toThrow(`Genio's ${HELPER} is missing from this install (looked in ${tried.join(', ')})`)
  })
})

/** Every resources/*.mjs module that src/main pulls into the main bundle, through any chain of relative imports. */
function bundledResourceModules(): string[] {
  const seen = new Set<string>(), modules = new Set<string>()
  const walk = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    if (file.endsWith('.mjs')) modules.add(file)
    for (const [, spec] of fs.readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), spec)
      const resolved = [target, `${target}.ts`, path.join(target, 'index.ts')].find(f => fs.existsSync(f) && fs.statSync(f).isFile())
      if (resolved && /\.(?:m?js|ts)$/.test(resolved) && !resolved.endsWith('.d.mts')) walk(resolved)
    }
  }
  const main = path.join(repo, 'src', 'main')
  for (const name of fs.readdirSync(main, { recursive: true }) as string[]) if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) walk(path.join(main, name))
  return [...modules].filter(f => f.startsWith(path.join(repo, 'resources') + path.sep))
}

describe('resources bundled into the main process', () => {
  it('locate their sibling files through the resource resolver, never their own module path', () => {
    const modules = bundledResourceModules()
    expect(modules.map(f => path.relative(plugin, f).replace(/\\/g, '/'))).toEqual(expect.arrayContaining(['lib/hidden-desktop.mjs', 'lib/resource-path.mjs', 'skills/play/scripts/pool.mjs']))
    const own = modules.filter(f => path.basename(f) !== 'resource-path.mjs' && /import\.meta\.(?:url|dirname|filename)|__dirname|__filename/.test(fs.readFileSync(f, 'utf8')))
    expect(own.map(f => path.relative(repo, f))).toEqual([])
  }, 30_000)

  it('resolve every runtime resource from the electron-vite bundle in dev and packaged layouts', async () => {
    const config = path.join(root, 'electron.vite.config.mjs'), app = path.join(root, 'app'), out = path.join(app, 'out', 'main')
    // Genio's own main preset (CJS, import.meta shims), with only the probe as its entry.
    fs.writeFileSync(config, `export default ${JSON.stringify({ main: { build: { outDir: out, emptyOutDir: true, rollupOptions: { input: { index: path.join(repo, 'tests', 'support', 'resource-probe.ts') } } } } })}`)
    await build({ configFile: config, root: repo, logLevel: 'silent' })
    const probe = (bundle: string, env: NodeJS.ProcessEnv = {}): Record<string, string> =>
      JSON.parse(execFileSync(process.execPath, [bundle], { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true }))

    // Nothing beside the bundle: the failure names the file and where it looked.
    expect(probe(path.join(out, 'index.js'))['hidden-desktop helper source']).toMatch(/^error: Genio's lib\/hidden-desktop\/GenioDesktop\.cs is missing .*out[\\/]lib[\\/]hidden-desktop/)

    // <app>/out/main + <app>/resources: the dev checkout, and resources/app when packaged.
    fs.symlinkSync(path.join(repo, 'resources'), path.join(app, 'resources'), 'junction')
    try {
      const found = probe(path.join(out, 'index.js'))
      expect(found['hidden-desktop helper source']).toBe(path.join(app, 'resources', 'unit-skills', 'genio', HELPER))
      for (const file of Object.values(found)) expect(fs.existsSync(file), file).toBe(true)

      // A bundle away from the app folder still finds the packaged resources through process.resourcesPath.
      const moved = path.join(root, 'elsewhere', 'main', 'index.js'), packaged = path.join(root, 'Genio', 'resources')
      fs.mkdirSync(path.dirname(moved), { recursive: true }); fs.copyFileSync(path.join(out, 'index.js'), moved)
      fs.mkdirSync(packaged, { recursive: true }); fs.symlinkSync(app, path.join(packaged, 'app'), 'junction')
      try {
        expect(probe(moved, { PROBE_RESOURCES_PATH: packaged })['hidden-desktop helper source']).toBe(path.join(packaged, 'app', 'resources', 'unit-skills', 'genio', HELPER))
      } finally { fs.unlinkSync(path.join(packaged, 'app')) }
    } finally { fs.unlinkSync(path.join(app, 'resources')) }
  }, 120_000)

  it('ship the app-root resources the main process reads in a packaged build', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
    expect(pkg.build.files).toEqual(expect.arrayContaining(['out/**/*', 'resources/**/*']))
    expect(pkg.build.asar).toBe(false)
    for (const rel of [`unit-skills/genio/${HELPER}`, 'unit-skills/genio/.claude-plugin/plugin.json', 'unity/com.genio.play/package.json', 'fal-catalogue.json', 'genio-chat-mcp.mjs', 'icon.ico', 'icon.png'])
      expect(fs.existsSync(path.join(repo, 'resources', rel)), rel).toBe(true)
  })
})
