/**
 * Files that ship beside this plugin's code (the hidden-desktop C# helper, ...). The same module runs in three
 * layouts, and import.meta.url alone only knows the first:
 *
 *   plugin       <plugin>/lib/*.mjs, run by plain Node from the checkout or a unit's installed copy
 *   bundled      <app>/out/main/index.js, where electron-vite inlines the module into Genio's main process;
 *                <app> is the checkout in dev and resources/app in a packaged build (asar off, resources/** shipped)
 *   packaged     <process.resourcesPath>/app/resources/unit-skills/genio, for a bundle that moved elsewhere
 *
 * Node 18+, standard library only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.join('resources', 'unit-skills', 'genio')

/** Where this plugin's root may be, most specific first. */
export function pluginRoots({ here = HERE, resourcesPath = process.resourcesPath } = {}) {
  const roots = [path.resolve(here, '..'), path.resolve(here, '..', '..', PLUGIN)]
  if (resourcesPath) roots.push(path.join(resourcesPath, 'app', PLUGIN))
  return [...new Set(roots)]
}

/** The absolute path of `rel` (relative to the plugin root); throws naming the file and every place searched. */
export function pluginFile(rel, options) {
  const tried = pluginRoots(options).map(root => path.join(root, rel))
  const found = tried.find(file => fs.existsSync(file))
  if (found) return found
  throw new Error(`Genio's ${rel.replace(/\\/g, '/')} is missing from this install (looked in ${tried.join(', ')}). Reinstall Genio or restore resources/unit-skills/genio`)
}
