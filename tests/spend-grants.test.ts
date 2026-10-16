import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppCtx } from '../src/main/services'
import type { ChatMessage, Decision, Project, Task } from '../src/shared/types'
import {
  answerSpendChoice, approvesSpend, checkDeployBudget, grantAtDeploy, grantEnv, grantsFor, recordGrant, spendChoice, unitGrantFile, writeUnitGrant
} from '../src/main/spend-grants'
import { answerChoice, createToolRegistry } from '../src/main/wksp-tools'
import { moneyAmounts, verifySpendWords } from '../src/main/player-words'
import { parseStatusLine } from '../src/main/status'
import { readGrant } from '../resources/unit-skills/genio/lib/spend-grant.mjs'

let dir: string, data: string, project: Project, ctx: AppCtx, decisions: Decision[], sent: string[], said: string[], history: ChatMessage[]
const task = { id: 't-s1', kind: 'ship', title: 'Door sounds', project: 'test', wksp: 'main', state: 'needs-decision' } as Task
const taskDir = (): string => path.join(data, task.id)
const unitEnv = (): Record<string, string> => ({ ...grantEnv(data, taskDir()), GENIO_TASK_ID: task.id })
const write = (relative: string, value: unknown): void => {
  const file = path.join(project.path, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}
const msg = (id: string, text: string, ago: number, role: ChatMessage['role'] = 'player'): ChatMessage => ({ id, role, text, ts: new Date(Date.now() - ago).toISOString() }) as ChatMessage
/** A unit's spend question as Genio opens it from its status line. */
function ask(id: string, line: string, granted = 0): Decision {
  const e = parseStatusLine(line, task.id)
  const { spend, ...choice } = JSON.parse(e.fields.choice!) as Partial<Decision> & { spend?: number }
  const d = { id, key: e.key!, wksp: 'main', taskId: task.id, project: 'test', question: e.text, source: 'unit', urgency: 'normal', createdAt: new Date(Date.now() - 30_000).toISOString(), options: [], ...choice, ...(spend ? spendChoice(task, spend, granted, choice.context) : {}) } as Decision
  decisions.push(d)
  return d
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-grants-'))
  data = path.join(dir, 'data')
  project = { name: 'test', path: path.join(dir, 'world') } as Project
  fs.mkdirSync(project.path, { recursive: true })
  decisions = []; sent = []; said = []; history = []
  const hc = {
    home: { name: 'main', data, taskDir: (id: string) => path.join(data, id) },
    decisions: {
      get: (id: string) => decisions.find((d) => d.id === id),
      resolve: (id: string, answer: string) => Object.assign(decisions.find((d) => d.id === id)!, { resolvedAt: new Date().toISOString(), answer })
    },
    crew: {
      get: (id: string) => (id === task.id ? task : undefined),
      send: vi.fn(async (_id: string, text: string) => { sent.push(text); return { ok: true, message: 'pinged' } }),
      appendStatus: vi.fn(),
      spawn: vi.fn(async (req: Record<string, unknown>) => ({ ...task, id: 't-new', ...req, branch: 'genio/t-new', harness: 'claude', kind: 'ship', mode: 'local-only' }))
    },
    backlog: { get: () => undefined },
    wksp: { say: (text: string) => said.push(text), history: () => history }
  }
  ctx = { main: hc, homes: new Map([['main', hc]]), home: () => hc, projects: { get: (n: string) => (n === 'test' ? project : undefined) }, ledger: { record: vi.fn() } } as unknown as AppCtx
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('spend grants', () => {
  it('records grants that add up and verify for the unit, signed with a key the unit never gets', () => {
    expect(readGrant(unitEnv())).toMatchObject({ ok: false, reason: expect.stringMatching(/No spend grant/) })
    grantAtDeploy(ctx, task, 0.5, 'approved budget in the Deploy dialog')
    recordGrant({ dataDir: data, taskDir: taskDir(), unit: task.id, project: 'test', usd: 0.25, how: 'approved spend question ch-1 in the choice panel', decision: 'ch-1' })
    const g = readGrant(unitEnv())
    expect(g).toMatchObject({ ok: true, total_usd: 0.75 })
    expect(g.ok && g.approval).toBe('USD 0.5 by the player (approved budget in the Deploy dialog); USD 0.25 by the player (approved spend question ch-1 in the choice panel)')
    // the unit's file and environment carry the public key and the signature only
    const file = fs.readFileSync(unitGrantFile(taskDir()), 'utf8')
    expect(file + JSON.stringify(unitEnv())).not.toMatch(/PRIVATE KEY/)
    expect(fs.readFileSync(path.join(data, 'spend-grant-key.json'), 'utf8')).toMatch(/PRIVATE KEY/)
    expect(path.relative(taskDir(), path.join(data, 'spend-grant-key.json')).startsWith('..')).toBe(true)

    // a unit that raises its grant has none; Genio's next write restores the record
    const raised = JSON.parse(file)
    raised.total_usd = 5; raised.grants[0].usd = 4.75
    fs.writeFileSync(unitGrantFile(taskDir()), JSON.stringify(raised))
    expect(readGrant(unitEnv())).toMatchObject({ ok: false, reason: expect.stringMatching(/signature/) })
    writeUnitGrant(data, taskDir(), task.id, 'test')
    expect(readGrant(unitEnv())).toMatchObject({ ok: true, total_usd: 0.75 })
  })

  it('never grants past the project monthly cap, which stays a hard stop', () => {
    write('.genio/fal/config.json', { budget: { monthly_usd: 1 } })
    expect(() => checkDeployBudget(ctx, 'test', 2)).toThrow(/above test's monthly cap/)
    expect(grantAtDeploy(ctx, task, 0.6, 'approved budget in the Deploy dialog')).toMatchObject({ granted: 0.6, total: 0.6, clamped: false })
    const d = ask('ch-1', 'needs-decision [key=spend]: May I make 4 more sounds? || {"spend_usd":0.8}', 0.6)
    expect(answerSpendChoice(ctx, d, 'Approve USD 0.80', { via: 'ui' }, task)).toMatchObject({ recorded: { granted: 0.4, total: 1, clamped: true } })
    const more = ask('ch-2', 'needs-decision [key=spend2]: And one more? || {"spend_usd":0.1}', 1)
    expect(answerSpendChoice(ctx, more, 'Approve USD 0.10', { via: 'ui' }, task).note).toMatch(/could not record the grant: The project's monthly cap/)
    expect(grantsFor(data, task.id).map((g) => g.usd)).toEqual([0.6, 0.4])
  })

  it("turns the player's approval of a unit's spend question into exactly that grant, and nothing else into any", async () => {
    const d = ask('ch-1', 'needs-decision [key=spend]: May I generate 4 door sounds? || {"spend_usd":0.4,"details":"4 x 2 s ElevenLabs, est. USD 0.016 each"}')
    expect(d).toMatchObject({ options: ['Approve USD 0.40', 'Decline'], recommendation: undefined, action: { kind: 'spend-grant', task: 't-s1', usd: 0.4 } })
    expect(d.context).toMatch(/^4 x 2 s ElevenLabs.*\n\nApproving records a spend grant of USD 0\.40 for this unit \(USD 0\.00 approved so far, USD 0\.40 after\)/s)

    // the player clicks Approve in the choice panel: exactly USD 0.40, before the unit hears the answer
    expect(await answerChoice(ctx, 'ch-1', 'Approve USD 0.40')).toMatchObject({ ok: true })
    expect(grantsFor(data, task.id)).toEqual([expect.objectContaining({ usd: 0.4, requested: 0.4, by: 'player', how: 'approved spend question ch-1 in the choice panel', decision: 'ch-1' })])
    expect(readGrant(unitEnv())).toMatchObject({ ok: true, total_usd: 0.4 })
    expect(sent[0]).toMatch(/^Answer to your open question \(spend\): Approve USD 0\.40\nGenio recorded your spend grant: USD 0\.40 approved by the player\. Your total approved spend is now USD 0\.40\./)
    expect(said[0]).toBe('Spend approved for t-s1 ("Door sounds"): USD 0.40; its total approved spend is USD 0.40.')
    // a second click on the answered choice grants nothing more
    expect(await answerChoice(ctx, 'ch-1', 'Approve USD 0.40')).toMatchObject({ message: 'already answered' })

    // a decline, another amount, or a chat answer that is not the player's own words: no grant
    ask('ch-2', 'needs-decision [key=spend2]: And 2 more? || {"spend_usd":0.2}', 0.4)
    await answerChoice(ctx, 'ch-2', 'Decline')
    expect(sent.at(-1)).toMatch(/No spend was approved by this answer, so Genio recorded no grant/)
    ask('ch-3', 'needs-decision [key=spend3]: And 2 more? || {"spend_usd":0.2}', 0.4)
    await answerChoice(ctx, 'ch-3', 'Approve USD 0.80')
    ask('ch-4', 'needs-decision [key=spend4]: And 2 more? || {"spend_usd":0.2}', 0.4)
    await answerChoice(ctx, 'ch-4', 'yes', { via: 'chat', chat: 'main' })
    expect(sent.at(-1)).toMatch(/Only the player's own answer approves spending/)
    expect(grantsFor(data, task.id)).toHaveLength(1)

    // the player's own chat reply, verified, approves it
    ask('ch-5', 'needs-decision [key=spend5]: And 2 more? || {"spend_usd":0.2}', 0.4)
    await answerChoice(ctx, 'ch-5', 'yes', { via: 'chat', chat: 'main', message: 'm9' })
    expect(readGrant(unitEnv())).toMatchObject({ ok: true, total_usd: 0.6 })
  })

  it('answers approve only the asked amount', () => {
    expect(approvesSpend('Approve USD 0.40', 0.4)).toBe(true)
    expect(approvesSpend('yes', 0.4)).toBe(true)
    expect(approvesSpend('ok, approve 0.40', 0.4)).toBe(true)
    for (const no of ['Decline', 'no', 'not now', 'Approve USD 0.80', 'yes but only 0.20', 'maybe later', '']) expect(approvesSpend(no, 0.4), no).toBe(false)
  })

  it('a malformed spend amount opens no spend question', () => {
    const e = parseStatusLine('needs-decision [key=spend]: May I? || {"spend_usd":"lots"}', task.id)
    expect(e.fields.choice).toBeUndefined()
    expect(JSON.parse(parseStatusLine('blocked [key=x]: stuck || {"spend_usd":1}', task.id).fields.choice!).spend).toBeUndefined()
  })
})

describe('approved budget at deploy', () => {
  it("counts only the player's own words that approve and name the amount", () => {
    history = [
      msg('m1', 'Make the door sounds, you can spend up to $0.50 on it', 60_000),
      msg('m2', 'can it spend $2?', 50_000),
      msg('m3', "don't spend $3 on this", 40_000),
      msg('g1', 'I will give it a $5 budget', 30_000, 'genio'),
      msg('m4', 'go ahead with 50 cents', 20_000)
    ]
    expect(verifySpendWords(history, 'you can spend up to $0.50 on it', 0.5)).toMatchObject({ ok: true, messageId: 'm1' })
    expect(verifySpendWords(history, 'you can spend up to $0.50 on it', 1)).toMatchObject({ ok: false, reason: expect.stringMatching(/does not name the amount USD 1/) })
    expect(verifySpendWords(history, 'can it spend $2?', 2)).toMatchObject({ ok: false, reason: expect.stringMatching(/question/) })
    expect(verifySpendWords(history, "don't spend $3 on this", 3).ok).toBe(false)
    expect(verifySpendWords(history, 'I will give it a $5 budget', 5)).toMatchObject({ ok: false, reason: expect.stringMatching(/not in any of the player's own messages/) })
    expect(verifySpendWords(history, 'go ahead with 50 cents', 0.5).ok).toBe(true)
    expect(moneyAmounts('USD 2, 3 sounds, 0.75 and 2 dollars')).toEqual([2, 2, 0.75])
  })

  it('the deploy tool records an approved budget only with those words, and never for the Bot', async () => {
    history = [msg('m1', 'make 3 door sounds, approve $0.50 for it', 10_000)]
    const deploy = (role: 'genio' | 'bot') => createToolRegistry(() => ctx, (ctx.main as unknown as { home: never }).home, role).find((t) => t.name === 'deploy')!
    const a = { kind: 'ship', world: 'test', title: 'Door sounds', intent: 'make 3 door sounds', generator: true, budget_usd: 0.5 }
    const spawn = (ctx.main as unknown as { crew: { spawn: ReturnType<typeof vi.fn> } }).crew.spawn
    expect((await deploy('genio').invoke(a)).isError).toBe(true)
    expect((await deploy('genio').invoke({ ...a, budget_usd: 1, player_words: 'approve $0.50 for it' })).isError).toBe(true)
    expect((await deploy('bot').invoke({ ...a, player_words: 'approve $0.50 for it' })).isError).toBe(true)
    expect(spawn).not.toHaveBeenCalled()
    const ok = await deploy('genio').invoke({ ...a, player_words: 'approve $0.50 for it' })
    expect(ok.isError).toBeFalsy()
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ approvedBudget: { usd: 0.5, via: 'chat', words: 'approve $0.50 for it' } }))
    // without budget_usd the unit starts with no grant and asks
    await deploy('genio').invoke({ ...a, budget_usd: undefined })
    expect(spawn.mock.lastCall?.[0].approvedBudget).toBeUndefined()
  })
})
