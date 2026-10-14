import os from 'node:os'
import { afterAll, afterEach, beforeEach, inject } from 'vitest'
import { assertChildHomes, assertIsolatedHomes, assertTempPath, createIsolatedHomes } from './isolated-homes.mjs'

declare module 'vitest' { export interface ProvidedContext { testRunRoot: string } }

// Runs before test modules load, including mocked Electron entry points and SDKs.
const homes = createIsolatedHomes('worker-', inject('testRunRoot'))
homes.install()
assertChildHomes({ ...process.env })
// An ambient visual-check request must not turn mocked entry-point tests into tours.
for (const key of Object.keys(process.env)) if (key.startsWith('GENIO_CAPTURE_')) delete process.env[key]
const guard = (): void => { assertIsolatedHomes(); assertTempPath(os.homedir(), 'os.homedir()') }
beforeEach(guard)
afterEach(guard)
afterAll(() => homes.dispose())
