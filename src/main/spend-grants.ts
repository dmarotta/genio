/**
 * Spend grants, main side (the format and the units' check live in
 * resources/unit-skills/genio/lib/spend-grant.mjs). No unit spends money
 * without the player's approval: Genio records a grant only from a player
 * action, an approved budget at deploy (the Deploy dialog, or the deploy tool
 * with the player's verified words) or the player's approval of the unit's
 * spend question in the choice panel. A unit's grants add up and never pass the
 * project's monthly cap, which stays a hard stop on its own.
 *
 * Main's record is data/spend-grants.jsonl; each unit gets a signed copy in its
 * data folder (GENIO_SPEND_GRANT). The Ed25519 signing key stays in the main
 * base's data, encrypted with safeStorage when the OS offers it; a unit gets
 * only the public key (GENIO_SPEND_KEY), so it cannot write or raise its own
 * grant, and the main chat has no tool that records one.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import type { Decision, Task } from '@shared/types'
import {
  GRANT_FILE, GRANT_FILE_ENV, GRANT_KEY_ENV, GRANT_SCHEMA, grantTotal, signGrant, type GrantEntry, type SpendGrant
} from '../../resources/unit-skills/genio/lib/spend-grant.mjs'
import type { AppCtx } from './services'
import { generationBudget } from './generation-spend'
import { appendJsonl, ensureDir, fwd, nowIso, readJsonl, writeJsonAtomic } from './util'

/** One line of main's grant record. */
export interface GrantLine extends GrantEntry {
  unit: string
  project?: string
  /** what the player was asked to approve (more than `usd` only when the monthly cap clipped it) */
  requested: number
}

interface KeyRecord { public: string; enc?: string; pem?: string }

const KEY_FILE = 'spend-grant-key.json'
export const grantsLedger = (dataDir: string): string => path.join(dataDir, 'spend-grants.jsonl')
export const unitGrantFile = (taskDir: string): string => path.join(taskDir, GRANT_FILE)
const round = (n: number): number => Math.round(n * 1e6) / 1e6
export const fmtUsd = (n: number): string => (Math.round(n * 100) === n * 100 ? n.toFixed(2) : String(round(n)))

function vault(): typeof safeStorage | undefined {
  try {
    return safeStorage?.isEncryptionAvailable?.() ? safeStorage : undefined
  } catch {
    return undefined
  }
}

const keys = new Map<string, { privateKey: crypto.KeyObject; publicKey: string }>()

/** Genio's signing key: made once; the private half never leaves main's data. */
export function signingKey(dataDir: string): { privateKey: crypto.KeyObject; publicKey: string } {
  const cached = keys.get(dataDir)
  if (cached) return cached
  let rec: KeyRecord | undefined
  let privateKey: crypto.KeyObject | undefined
  try {
    rec = JSON.parse(fs.readFileSync(path.join(dataDir, KEY_FILE), 'utf8')) as KeyRecord
    const pem = rec.enc ? vault()?.decryptString(Buffer.from(rec.enc, 'base64')) : rec.pem
    if (pem && rec.public) privateKey = crypto.createPrivateKey(pem)
  } catch {
    privateKey = undefined
  }
  if (!privateKey || !rec?.public) {
    // A key that cannot be opened is replaced; grants are re-signed from the record on the next write.
    const pair = crypto.generateKeyPairSync('ed25519')
    const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const v = vault()
    rec = { public: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), ...(v ? { enc: v.encryptString(pem).toString('base64') } : { pem }) }
    ensureDir(dataDir)
    writeJsonAtomic(path.join(dataDir, KEY_FILE), rec)
    privateKey = pair.privateKey
  }
  const out = { privateKey, publicKey: rec.public }
  keys.set(dataDir, out)
  return out
}

/** Every grant main recorded for a unit, oldest first. */
export function grantsFor(dataDir: string, unit: string): GrantLine[] {
  return readJsonl<GrantLine>(grantsLedger(dataDir)).filter((g) => g?.unit === unit && typeof g.usd === 'number' && g.usd > 0)
}

export const grantedUsd = (dataDir: string, unit: string): number => grantTotal(grantsFor(dataDir, unit))

/** A unit's environment for its paid helpers: Genio's public key and where its grant is. Never the private key. */
export function grantEnv(dataDir: string, taskDir: string): Record<string, string> {
  return { [GRANT_KEY_ENV]: signingKey(dataDir).publicKey, [GRANT_FILE_ENV]: fwd(unitGrantFile(taskDir)) }
}

/** Write the unit's signed grant from main's record (which also undoes any edit a unit made to the file). */
export function writeUnitGrant(dataDir: string, taskDir: string, unit: string, project?: string): SpendGrant {
  const grants = grantsFor(dataDir, unit).map(({ usd, at, by, how, decision }) => ({ usd, at, by, how, ...(decision ? { decision } : {}) }))
  const grant = signGrant({ schema: GRANT_SCHEMA, unit, ...(project ? { project } : {}), total_usd: grantTotal(grants), grants, updated: nowIso() }, signingKey(dataDir).privateKey)
  ensureDir(taskDir)
  writeJsonAtomic(unitGrantFile(taskDir), grant)
  return grant
}

export interface GrantRequest {
  dataDir: string
  taskDir: string
  unit: string
  project?: string
  usd: number
  /** who approved it and how, in the player's terms */
  how: string
  decision?: string
  /** the project's monthly cap: a unit's grants never add up past it */
  capUsd?: number
}

/** What a unit may still be granted under the project's monthly cap (Infinity without one). */
export function grantRoom(dataDir: string, unit: string, capUsd?: number): number {
  return capUsd === undefined ? Infinity : Math.max(0, round(capUsd - grantedUsd(dataDir, unit)))
}

/**
 * Record the player's approval of `usd` for a unit and re-sign its grant. Past
 * the monthly cap nothing more is granted: the grant is clipped to the room
 * left, and with no room it throws and records nothing.
 */
export function recordGrant(r: GrantRequest): { granted: number; total: number; clamped: boolean } {
  if (!(Number.isFinite(r.usd) && r.usd > 0)) throw new Error('A spend grant is a positive USD amount.')
  const granted = round(Math.min(r.usd, grantRoom(r.dataDir, r.unit, r.capUsd)))
  if (!(granted > 0)) throw new Error(`The project's monthly cap (USD ${fmtUsd(r.capUsd ?? 0)}) leaves no room to approve more spend for ${r.unit}.`)
  const line: GrantLine = { unit: r.unit, ...(r.project ? { project: r.project } : {}), usd: granted, requested: round(r.usd), at: nowIso(), by: 'player', how: r.how, ...(r.decision ? { decision: r.decision } : {}) }
  ensureDir(r.dataDir)
  appendJsonl(grantsLedger(r.dataDir), line)
  const grant = writeUnitGrant(r.dataDir, r.taskDir, r.unit, r.project)
  return { granted, total: grant.total_usd, clamped: granted < r.usd }
}

/** The project's monthly cap, or undefined when it has none (or its config cannot be read). */
function capOf(ctx: AppCtx, project: string): number | undefined {
  try {
    return generationBudget(ctx, project)?.monthly_usd
  } catch {
    return undefined
  }
}

/** Where a unit's grant lives and what bounds it. */
export function grantTarget(ctx: AppCtx, task: Pick<Task, 'id' | 'project' | 'workspace'>): Omit<GrantRequest, 'usd' | 'how' | 'decision'> {
  return { dataDir: ctx.main.home.data, taskDir: ctx.home(task.workspace).home.taskDir(task.id), unit: task.id, project: task.project, capUsd: capOf(ctx, task.project) }
}

/** Refuse a deploy budget the project's monthly cap cannot hold, before anything is created. */
export function checkDeployBudget(ctx: AppCtx, project: string, usd: number): void {
  if (!(Number.isFinite(usd) && usd > 0)) throw new Error('An approved budget is a positive USD amount.')
  const cap = capOf(ctx, project)
  if (cap !== undefined && usd > cap + 1e-9) throw new Error(`The approved budget (USD ${fmtUsd(usd)}) is above ${project}'s monthly cap (USD ${fmtUsd(cap)}), which stays a hard stop. Approve at most the cap, or raise the cap in Settings.`)
}

const NEGATIVE = /^(?:no|nope|not|don'?t|do not|declin\w*|reject\w*|refus\w*|deny|denied|wait|later|hold|stop|cancel\w*|never|skip)\b/
const YES = /^(?:yes|yeah|yep|y|ok|okay|sure|approv\w*|go(?: ahead)?|do it|spend it|fine|accept\w*|confirm\w*)\b/

/** Spend choice options: approving is the first, word for word. */
export const spendOptions = (usd: number): string[] => [`Approve USD ${fmtUsd(usd)}`, 'Decline']

/**
 * A unit's spend question (a needs-decision with spend_usd) as a choice: approve or decline
 * exactly the asked amount, with what the unit already has. No recommendation, so it is never
 * approved in a batch of recommended answers.
 */
export function spendChoice(t: Pick<Task, 'id'>, usd: number, granted: number, details?: string): Partial<Decision> {
  return {
    options: spendOptions(usd),
    recommendation: undefined,
    context: [
      details?.trim(),
      `Approving records a spend grant of USD ${fmtUsd(usd)} for this unit (USD ${fmtUsd(granted)} approved so far, USD ${fmtUsd(granted + usd)} after). The project's monthly cap still stops everything. Declining records nothing.`
    ].filter(Boolean).join('\n\n'),
    action: { kind: 'spend-grant', task: t.id, usd }
  }
}

/**
 * Whether an answer approves the spend question's amount: its first option, or a plain yes. An
 * answer naming another amount approves nothing (the question changed, or the player said less).
 */
export function approvesSpend(answer: string, usd: number, options: string[] = spendOptions(usd)): boolean {
  const norm = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').replace(/^["'\s]+|["'\s.!,;:…]+$/g, '').trim()
  const a = norm(answer)
  if (!a || NEGATIVE.test(a)) return false
  const numbers = (a.match(/\d+(?:\.\d+)?/g) ?? []).map(Number)
  if (numbers.some((n) => Math.abs(n - usd) > 1e-9)) return false
  if (options[0] && a === norm(options[0])) return true
  return YES.test(a)
}

/**
 * The player's answer to a unit's spend question. An approving answer from the
 * choice panel, or the player's own chat reply that Genio verified, records a
 * grant of exactly the asked amount (within the monthly cap), once per
 * question; anything else records nothing. `note` is what the unit's ping adds.
 */
export function answerSpendChoice(
  ctx: AppCtx, d: Decision, answer: string, origin: { via: 'ui' } | { via: 'chat'; message?: string }, task: Pick<Task, 'id' | 'project' | 'workspace'>
): { note: string; recorded?: { granted: number; total: number; clamped: boolean } } {
  if (d.action?.kind !== 'spend-grant') return { note: '' }
  const usd = d.action.usd
  const player = origin.via === 'ui' || !!origin.message
  if (!player || !approvesSpend(answer, usd, d.options)) {
    return { note: `\nNo spend was approved by this answer, so Genio recorded no grant: do not make the paid call.${player ? '' : " Only the player's own answer approves spending."}` }
  }
  try {
    const target = grantTarget(ctx, task)
    // A resend of the same answer (a failed ping) never grants twice.
    const earlier = grantsFor(target.dataDir, task.id).find((g) => g.decision === d.id)
    const how = origin.via === 'ui' ? `approved spend question ${d.id} in the choice panel` : `approved spend question ${d.id} in chat, in their own words`
    const r = earlier ? { granted: earlier.usd, total: grantedUsd(target.dataDir, task.id), clamped: earlier.usd < usd } : recordGrant({ ...target, usd, how, decision: d.id })
    if (!earlier) safeLedger(ctx, task, { decision: d.id, usd: r.granted, total: r.total, via: origin.via })
    return {
      recorded: r,
      note: `\nGenio recorded your spend grant: USD ${fmtUsd(r.granted)} approved by the player${r.clamped ? ` (clipped from USD ${fmtUsd(usd)} by the project's monthly cap)` : ''}. Your total approved spend is now USD ${fmtUsd(r.total)}. Continue with the paid calls you asked for.`
    }
  } catch (e) {
    return { note: `\nThe player approved, but Genio could not record the grant: ${(e as Error).message} Do not make the paid call.` }
  }
}

/** Record a deploy-time approved budget for a new unit. */
export function grantAtDeploy(ctx: AppCtx, task: Pick<Task, 'id' | 'project' | 'workspace'>, usd: number, how: string): { granted: number; total: number; clamped: boolean } {
  const r = recordGrant({ ...grantTarget(ctx, task), usd, how })
  safeLedger(ctx, task, { usd: r.granted, total: r.total, via: 'deploy' })
  return r
}

/** A recorded grant: the event ledger line and the player's achievement. */
function safeLedger(ctx: AppCtx, task: Pick<Task, 'id' | 'project' | 'workspace'>, data: Record<string, unknown>): void {
  try {
    ctx.ledger.record({ home: task.workspace, event: 'spend.granted', task: task.id, project: task.project, data })
  } catch {
    /* the grant record is the source of truth */
  }
  try {
    ctx.stats.unlock('unit-spend-grant')
  } catch {
    /* optional */
  }
}
