// Bundled by tests/resource-path.test.ts with Genio's electron-vite main preset, like src/main, then run with
// plain Node from the bundle's out/main folder. Prints every plugin resource the bundled modules resolve at runtime.
import { helperSource } from '../../resources/unit-skills/genio/lib/hidden-desktop.mjs'

if (process.env.PROBE_RESOURCES_PATH) Object.assign(process, { resourcesPath: process.env.PROBE_RESOURCES_PATH })
const resolve = (name: string, fn: () => string): [string, string] => { try { return [name, fn()] } catch (e) { return [name, `error: ${(e as Error).message}`] } }
process.stdout.write(JSON.stringify(Object.fromEntries([resolve('hidden-desktop helper source', helperSource)])))
