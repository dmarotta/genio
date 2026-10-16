/** Signed spend grants for helper tests: what Genio's main process gives a unit, with a test key. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { GRANT_SCHEMA, grantTotal, signGrant } from '../../resources/unit-skills/genio/lib/spend-grant.mjs'

const pair = crypto.generateKeyPairSync('ed25519')
export const TEST_GRANT_KEY = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')

/**
 * Write `unit`'s grant of `usd` (one entry per amount) into `dir` and return the environment a unit
 * gets for it. `usd` empty writes no file: the unit has no grant.
 */
export function grantEnv(dir: string, unit: string, ...usd: number[]): Record<string, string> {
  const file = path.join(dir, 'spend-grant.json')
  if (usd.length) {
    const grants = usd.map((u, i) => ({ usd: u, at: `2026-10-16T10:0${i}:00.000Z`, by: 'player' as const, how: i ? `approved spend question ch-${i} in the choice panel` : 'approved budget in the Deploy dialog' }))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(signGrant({ schema: GRANT_SCHEMA, unit, total_usd: grantTotal(grants), grants, updated: '2026-10-16T10:00:00.000Z' }, pair.privateKey), null, 2))
  }
  return { GENIO_SPEND_KEY: TEST_GRANT_KEY, GENIO_SPEND_GRANT: file, GENIO_TASK_ID: unit }
}
