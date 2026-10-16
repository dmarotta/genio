/**
 * Spend grants: the player's approval of a unit's paid calls. Node 18+, standard library only.
 *
 * A unit spends money (FAL, Uthana, any paid provider) only under a grant, and a grant exists
 * only when Genio's main process recorded it from a player action: an approved budget at deploy
 * (the Deploy dialog, or the deploy tool with the player's own words) or the player's approval
 * of the unit's spend question in the choice panel. Grants add up per unit; the project's
 * monthly cap stays a hard stop on top of them. Codex images on the ChatGPT plan cost no money
 * and need no grant.
 *
 * The grant is a file in the unit's data folder (GENIO_SPEND_GRANT), signed with Genio's Ed25519
 * key. A unit gets only the public key (GENIO_SPEND_KEY), so a grant it writes, copies from
 * another unit or raises does not verify and approves nothing.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'

export const GRANT_SCHEMA = 'genio.spend-grant.v1'
export const GRANT_FILE = 'spend-grant.json'
export const GRANT_FILE_ENV = 'GENIO_SPEND_GRANT'
export const GRANT_KEY_ENV = 'GENIO_SPEND_KEY'

/** How a unit asks; every paid helper ends its refusal with it. */
export const ASK =
  'Ask the player first: append `needs-decision [key=spend]: <what you want to generate and why>` with JSON metadata ' +
  '{"spend_usd": <amount to approve>, "details": "<plan, estimate per call, total>"} to your status file, then stop and wait. ' +
  'When the player approves, Genio records the grant and pings you; then continue. Codex images on the ChatGPT plan need no approval.'

const usd = (n) => Math.round(n * 1e6) / 1e6
const amount = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** The signed bytes: the grant without its signature, as JSON in its own key order. */
function signedBytes(grant) {
  const { signature: _s, ...rest } = grant
  return Buffer.from(JSON.stringify(rest), 'utf8')
}

/** Total USD of a grant's entries. */
export function grantTotal(entries) {
  return usd((Array.isArray(entries) ? entries : []).reduce((a, g) => a + amount(g?.usd), 0))
}

/** Main process only: the grant with its signature. */
export function signGrant(grant, privateKey) {
  const { signature: _s, ...rest } = grant
  return { ...rest, signature: crypto.sign(null, signedBytes(rest), privateKey).toString('base64') }
}

/** Genio's public key from GENIO_SPEND_KEY (base64 SPKI DER). */
export function publicKeyOf(b64) {
  return crypto.createPublicKey({ key: Buffer.from(String(b64), 'base64'), format: 'der', type: 'spki' })
}

export function verifyGrant(grant, publicKey) {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant) || typeof grant.signature !== 'string') return false
  try {
    const key = typeof publicKey === 'string' ? publicKeyOf(publicKey) : publicKey
    return crypto.verify(null, signedBytes(grant), key, Buffer.from(grant.signature, 'base64'))
  } catch {
    return false
  }
}

/** One line on who approved the grant and how, for spend lines and reports. */
export function grantApproval(grant) {
  return (grant?.grants ?? []).map((g) => `USD ${usd(amount(g.usd))} by the ${g.by ?? 'player'} (${g.how ?? 'approval'})`).join('; ')
}

/**
 * This unit's grant as its helpers see it: { ok: true, total_usd, grants, approval, file }, or
 * { ok: false, reason } when there is none or it does not verify (both approve nothing).
 */
export function readGrant(env = process.env) {
  const file = env[GRANT_FILE_ENV]?.trim()
  const key = env[GRANT_KEY_ENV]?.trim()
  const unit = env.GENIO_TASK_ID?.trim()
  if (!file || !key || !unit) return { ok: false, reason: 'No spend grant: the player has approved no spending for you (no grant from Genio in this process).' }
  let grant
  try {
    grant = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
  } catch (e) {
    return { ok: false, reason: e?.code === 'ENOENT' ? 'No spend grant: the player has approved no spending for you yet.' : `Your spend grant (${file}) cannot be read, so it approves nothing.` }
  }
  if (grant?.schema !== GRANT_SCHEMA || !verifyGrant(grant, key)) {
    return { ok: false, reason: "Your spend grant does not carry Genio's signature, so it approves nothing. Only Genio records grants, from the player's approval; never write or edit that file." }
  }
  if (grant.unit !== unit) return { ok: false, reason: `This spend grant belongs to unit ${grant.unit}, not to you (${unit}).` }
  const total = grantTotal(grant.grants)
  if (Math.abs(total - Number(grant.total_usd)) > 1e-9) return { ok: false, reason: 'Your spend grant does not add up, so it approves nothing.' }
  return { ok: true, total_usd: total, grants: grant.grants, approval: grantApproval(grant), file }
}
