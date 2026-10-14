import { normalizeProjectArgs, projectAliasShape } from './project-tool-args'
/**
 * App-owned Genio tool registry (mcp__genio__*). Every mechanic is a
 * deterministic service call; the agent only supplies judgment. Guards that
 * companion enforced in scripts (merge authority, despawn force, outward
 * consent) are enforced here too, so a confused model cannot bypass them.
 */
import { z } from 'zod'
import { modeLabel } from '@shared/vocab'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Decision, Task } from '@shared/types'
import type { TaskFile } from '@shared/api'
import type { AnswerOrigin, AppCtx, HomeCtx } from './services'
import type { Home } from './home'
import { readText, slugify } from './util'
import { questOrder } from '@shared/quest-board'
import path from 'node:path'
import fs from 'node:fs'
import { ToolPages, isPagedTool, pageShape } from './tool-pages'
import { procedureText, PROCEDURES } from './prompts'
import { unitPluginSource } from './unitskills'
import { bus } from './bus'
import { resolveLoadout } from './loadout'
import { GENERATE_IMAGE_DESC, generateImageShape } from './chat-imagegen'
import { findAssets, assetInfo, locateAsset } from './asset-tools'
import { agentGeneration, falGenerateShape, uthanaMotionShape, uthanaCharacterShape, assetPlaceShape } from './agent-generation'
import { CATEGORY_IDS } from '@shared/dispatch'
import { playService } from './play'
import { formatStatusLine } from './status'
import { declareEngineRoot, projectEngineSummary } from './engine-facts'
import { choiceGroup, choiceRevision, recommendationAnswer, type RecommendationReview, type RecommendationResult } from '@shared/choice'

export type ToolRole = 'genio' | 'ally' | 'bot'

export interface AppTool {
  name: string
  description: string
  shape: z.ZodRawShape
  invoke(args: unknown): Promise<CallToolResult>
}

export interface ToolHooks {
  /** Bot only: surface something the player must see */
  escalate?: (text: string, severity: 'info' | 'decision' | 'failure' | 'ready') => void
}

const ok = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true })
const json = (v: unknown): string => JSON.stringify(v, null, 1)

/** On-demand evidence stays inside its task/skill folder, including symlinks. */
function readReference(root: string, file: string): string {
  if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..') || /[:\0]/.test(file)) throw new Error('Reference must stay inside its source folder')
  const base = fs.realpathSync(root)
  const target = fs.realpathSync(path.join(base, file))
  const relative = path.relative(base, target)
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Reference escapes its source folder')
  return fs.readFileSync(target, 'utf8')
}

/** Locate a task: own base first, then every other base. */
export function findTask(ctx: AppCtx, id: string, prefer?: Home): { hc: HomeCtx; task: Task } | undefined {
  const homes = [...ctx.homes.values()]
  if (prefer) homes.sort((a, b) => (a.home.name === prefer.name ? -1 : b.home.name === prefer.name ? 1 : 0))
  for (const hc of homes) {
    const task = hc.crew.get(id)
    if (task) return { hc, task }
  }
  return undefined
}

export function findDecision(ctx: AppCtx, id: string): { hc: HomeCtx; d: Decision } | undefined {
  for (const hc of ctx.homes.values()) {
    const d = hc.decisions.get(id)
    if (d) return { hc, d }
  }
  return undefined
}

/**
 * Answer a player choice everywhere it lives: ping the unit (closing the keyed
 * record), record it on a held quest, and resolve the choice.
 */
const activeChoices = new Set<string>()

async function withChoice(id: string, run: () => Promise<{ ok: boolean; message: string }>) {
  if (activeChoices.has(id)) return { ok: false, message: 'This choice is being sent. Try again shortly.' }
  activeChoices.add(id)
  try { return await run() } finally { activeChoices.delete(id) }
}

export function answerChoice(ctx: AppCtx, id: string, answer: string, origin: AnswerOrigin = { via: 'ui' }): Promise<{ ok: boolean; message: string }> {
  return withChoice(id, () => sendChoiceAnswer(ctx, id, answer, origin))
}

export function clarifyChoice(ctx: AppCtx, id: string, question: string): Promise<{ ok: boolean; message: string }> {
  return withChoice(id, async () => {
    if (!question.trim()) return { ok: false, message: 'Write a question first.' }
    const found = findDecision(ctx, id)
    if (!found || found.d.resolvedAt) return { ok: false, message: 'This choice is no longer pending.' }
    const { hc, d } = found
    const text = `Clarification requested for choice ${id} [key=${d.key}]: ${question.trim()}\nThis is a question, not an answer or approval. Keep the obligation open; reply with a clearer question, options and Details under the same key.`
    // A finished unit (a Recon with its report) cannot answer: its project chat does.
    const task = d.taskId ? findTask(ctx, d.taskId, hc.home) : undefined
    if (task && !['cleaned', 'done', 'merged'].includes(task.task.state)) {
      const r = await task.hc.crew.send(d.taskId!, text, [])
      if (!r.ok) return r
    } else {
      await hc.wksp.send(text, 'player')
    }
    hc.decisions.clarify(id, question.trim())
    return { ok: true, message: 'Question sent. The choice remains pending.' }
  })
}

export async function applyRecommendations(ctx: AppCtx, review: RecommendationReview[]): Promise<RecommendationResult[]> {
  if (!Array.isArray(review) || !review.length || review.length > 100) throw new Error('Review between 1 and 100 recommendations.')
  if (new Set(review.map(r => r.id)).size !== review.length || review.some(r => r.group !== review[0].group)) throw new Error('Review one related group with unique choice IDs.')
  const results: RecommendationResult[] = []
  // Only the captured IDs are considered, even if more choices arrive during delivery.
  for (const row of review) {
    try {
      const result = await withChoice(row.id, async () => {
        const found = findDecision(ctx, row.id)
        const d = found?.d
        if (!d || d.resolvedAt || (d.until && Date.parse(d.until) > Date.now()) || choiceGroup(d) !== row.group || choiceRevision(d) !== row.revision || recommendationAnswer(d) !== row.answer) {
          return { ok: false, message: 'Choice changed since review. Review it again.' }
        }
        return sendChoiceAnswer(ctx, row.id, row.answer, { via: 'ui' })
      })
      results.push({ id: row.id, ...result })
    } catch (error) {
      results.push({ id: row.id, ok: false, message: (error as Error).message })
    }
  }
  return results
}

async function sendChoiceAnswer(ctx: AppCtx, id: string, answer: string, origin: AnswerOrigin): Promise<{ ok: boolean; message: string }> {
  answer = answer.trim()
  if (!answer.trim()) return { ok: false, message: 'Write an answer first.' }
  const found = findDecision(ctx, id)
  if (!found) return { ok: false, message: `no choice ${id}` }
  const { hc, d } = found
  if (d.resolvedAt) return { ok: true, message: 'already answered' }
  if (d.until && Date.parse(d.until) > Date.now()) return { ok: false, message: 'This choice is deferred. Resume it before answering.' }
  let note = ''
  let recipient: ReturnType<typeof findTask>
  if (d.taskId) {
    const t = findTask(ctx, d.taskId, hc.home)
    if (t && !['cleaned', 'done', 'merged'].includes(t.task.state)) {
      recipient = t
      const r = await t.hc.crew.send(d.taskId, `Answer to your open question (${d.key}): ${answer}`, [])
      if (!r.ok) return { ok: false, message: `Ping failed: ${r.message}. The choice remains pending.` }
      note = ' and pinged the unit'
    } else {
      // A finished unit (a Recon with its report) cannot act on it: the project chat follows through.
      note = '; the unit has finished, so Genio follows through'
    }
  }
  hc.decisions.resolve(id, answer, { relay: false, origin })
  if (recipient) recipient.hc.crew.appendStatus(d.taskId!, formatStatusLine('resolved', `answered: ${answer}`, { key: d.key }))
  return { ok: true, message: `choice answered${note}` }
}

function taskLine(t: Task): Record<string, unknown> {
  return {
    id: t.id, kind: t.kind === 'ship' ? 'build' : 'recon', title: t.title, world: t.project, state: t.state,
    reason: t.stateReason, mode: t.mode, autoLoot: t.yolo, branch: t.branch, pr: t.pr?.url, checks: t.pr?.checks,
    unitTool: t.harness, model: t.model, effort: t.effort, category: t.category, verdict: t.verdict, base: t.wksp
  }
}

export function createToolRegistry(
  getCtx: () => AppCtx,
  home: Home,
  role: ToolRole,
  hooks: ToolHooks = {}
): AppTool[] {
  const hc = (): HomeCtx => getCtx().home(home.name)
  const questHome = (id: string): HomeCtx => [...getCtx().homes.values()].find(h => h.backlog.get(id)) ?? hc()
  const tools: AppTool[] = []
  const pages = new ToolPages()

  // Wrap every handler so a thrown error becomes a tool error, never a crash.
  function t<S extends z.ZodRawShape>(name: string, desc: string, shape: S, fn: (a: z.infer<z.ZodObject<S>>) => Promise<CallToolResult> | CallToolResult): void {
    const paged = isPagedTool(name)
    const inputShape = paged ? { ...shape, ...pageShape } : shape
    tools.push({
      name, description: desc + (paged ? ' Returns 2000-character pages by default; follow cursor with original arguments or request full=true.' : ''), shape: projectAliasShape(inputShape),
      async invoke(args) {
        try {
          const normalized = normalizeProjectArgs(args, inputShape)
          const input = z.object(inputShape).parse(normalized)
          const read = () => fn(z.object(shape).parse(normalized))
          return paged ? await pages.read(name, input, read) : await read()
        } catch (e) {
          return fail(`${name} failed: ${(e as Error)?.message ?? String(e)}`)
        }
      }
    })
  }

  const requireTask = (id: string): { hc: HomeCtx; task: Task } => {
    const f = findTask(getCtx(), id, home)
    if (!f) throw new Error(`no unit/mission with id "${id}"`)
    return f
  }

  const assetKind = z.enum(['image', 'audio', 'video', 'model', 'animation', 'material'])
  const play = (world: string) => {
    if (!home.isMain) {
      const owner = getCtx().allies.list().find(a => a.name === home.name && !a.retiredAt)
      if (!owner?.projects.includes(world)) throw new Error('Play project is outside this chat session')
    }
    return playService(getCtx())
  }
  t('play_status', 'Observe the session project Unity editor. Never launch another editor or use a unit against the main editor.', { world: z.string() }, async ({ world }) => ok(json(await play(world).status(world))))
  t('play_console', 'Read recent Unity console entries, following cursor and session.', { world: z.string(), cursor: z.number().int().optional(), session: z.string().optional() }, async ({ world, cursor, session }) => ok(json(await play(world).adapter(world).console(cursor, session))))
  t('play_stats', 'Observe Unity performance statistics.', { world: z.string() }, async ({ world }) => ok(json(await play(world).adapter(world).stats())))
  t('play_frame', 'Observe a fresh game PNG of the session project Unity editor.', { world: z.string() }, async ({ world }) => {
    const frame = await play(world).frame(world, 1280, 720)
    return { content: [{ type: 'image', data: frame.base64, mimeType: 'image/png' }, { type: 'text', text: `${frame.width}x${frame.height} captured ${frame.capturedAt}` }] }
  })
  t('play_control', 'Control Play only on the explicit player request quoted in player_words. Never save scenes or use eval. Units control only their own copy/slot.', {
    world: z.string(), player_words: z.string().trim().min(1), action: z.discriminatedUnion('type', [
      z.object({ type: z.enum(['play', 'pause', 'stop']) }), z.object({ type: z.literal('scene'), path: z.string() }),
      z.object({ type: z.literal('key'), key: z.string() }), z.object({ type: z.literal('pointer'), x: z.number().nonnegative(), y: z.number().nonnegative() })
    ])
  }, async ({ world, player_words, action }) => {
    if (role === 'bot') return fail('Play control waits for the player')
    await play(world).act(world, action, player_words)
    return ok('Play action completed')
  })
  t('play_slot_recover', 'Recover a shared Play slot a unit reported stuck, or one whose editor outlived its lease: closes only that slot\'s recorded Unity editor and child processes (graceful quit, then forced stop), never the main editor or Toolbox, and frees the slot. Refuses slots leased by a live unit. Never stop Unity processes any other way.', {
    world: z.string(), slot: z.number().int().min(1).max(8)
  }, async ({ world, slot }) => {
    await play(world).closeSlotEditor(world, slot, 'genio')
    return ok(`Play slot ${slot} editor closed; the slot is free`)
  })
  t('assets_find', 'Read-only project Inventory search. Supports browser syntax such as t:sfx, in:Audio, lfs:missing. Includes vendor assets; results never authorize writes.', {
    world: z.string(), query: z.string().optional(), kind: assetKind.optional(), folder: z.string().optional(), generated: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional()
  }, async ({ world, query, kind, folder, generated, limit }) => {
    const result = await findAssets(getCtx(), world, { query, kinds: kind ? [kind] : undefined, folder, generated, limit: limit ?? 50 })
    getCtx().stats.unlock('inventory-scout')
    return ok(json(result))
  })
  t('asset_info', 'Read-only asset metadata, cheap dimensions/duration, LFS pointer state, provenance and neighbouring indexed media. Paths are project-relative.', {
    world: z.string(), path: z.string()
  }, async ({ world, path }) => ok(json(await assetInfo(getCtx(), world, path))))
  t('asset_locate', 'Suggest ranked safe locations for a NEW asset using engine root, configured folders and measured naming conventions. hint is a folder or subject. Read-only; creates nothing.', {
    world: z.string(), kind: assetKind, name: z.string().optional(), hint: z.string().optional()
  }, async ({ world, kind, name, hint }) => {
    const result = await locateAsset(getCtx(), world, kind, name, hint)
    getCtx().stats.unlock('asset-pathfinder')
    return ok(json(result))
  })

  // ------------------------------------------------------------ squad
  t('event_read', 'Complete durable details for one event, including errors and continuation links.', { seq: z.number().int().positive() }, ({ seq }) => {
    const event = hc().wakes.get(seq)
    return event ? ok(json(event)) : fail(`No retained event #${seq}`)
  })
  t('events_ack', 'Durably acknowledge only the specific event IDs you have finished handling. Call after each event, before proceeding to the next.', { seqs: z.array(z.number().int().positive()).min(1).max(100) }, ({ seqs }) => {
    hc().wakes.ackEvents(seqs)
    return ok(`Acknowledged events: ${seqs.join(', ')}`)
  })

  t('procedure_read', 'Load a named Genio procedure only when relevant. ally includes this base charter and routing scope.', { name: z.enum(PROCEDURES) }, ({ name }) => {
    const a = home.isMain ? undefined : getCtx().allies.list().find(a => a.name === home.name && !a.retiredAt)
    return ok(procedureText(name, { gamertag: getCtx().settings.get().gamertag, base: home.name, isAlly: !home.isMain,
      charter: a ? readText(path.join(home.data, 'charter.md'), a.charter) : undefined, scope: a?.scope }))
  })
  t('skill_read', 'Load one bundled skill on demand. reference optionally reads a linked Markdown file relative to that skill directory. Follow pages before applying instructions. Never preload configuration manuals.', {
    name: z.enum(['assets', 'imagegen-codex', 'fal', 'uthana', 'blender']), reference: z.string().regex(/\.md$/i).optional()
  }, ({ name, reference }) => {
    const dir = path.join(unitPluginSource(getCtx().appRoot), 'skills', name)
    const text = readReference(dir, reference ?? 'SKILL.md')
    if (!text) return fail(`Bundled skill ${name} is unavailable`)
    return ok(`Skill directory: ${dir}\n\n${text.replace(/\{\{SKILL_DIR\}\}/g, dir.replace(/\\/g, '/'))}`)
  })
  const preferenceShape = { usageMode: z.enum(['save', 'balanced', 'max']).optional(), sound: z.boolean().optional(),
    soundVolume: z.number().min(0).max(1).optional(), voice: z.boolean().optional(), calm: z.boolean().optional(),
    fx: z.boolean().optional(), desktopNotifications: z.boolean().optional() }
  const preferences = () => {
    const s = getCtx().settings.get()
    return { usageMode: s.usageMode, sound: s.sound, soundVolume: s.soundVolume, voice: s.voice,
      calm: s.calm, fx: s.fx, desktopNotifications: s.desktopNotifications }
  }
  t('settings_read', 'Read supported chat/app preferences without secrets or large configuration skills. Advanced models, accounts and security settings are in Settings.', {}, () => ok(json(preferences())))
  t('settings_update', 'Change only these named preferences when the player requests it; quote their request. Does not change permissions, accounts or spending allowances.', {
    player_words: z.string().trim().min(1), patch: z.strictObject(preferenceShape)
  }, ({ patch }) => {
    if (role === 'bot' || !home.isMain) return fail('Global preferences require the player in main chat')
    const previous = getCtx().settings.get().usageMode
    getCtx().settings.save(patch)
    if (patch.usageMode && patch.usageMode !== previous) bus.publish({ type: 'feature-used', feature: 'usage-mode' })
    return ok(json(preferences()))
  })

  t('fleet_view', 'Squad view: every unit in this base (state, project, PR, artifact), plus queued/held quests and open choices. Use at session start, on ticks, and before re-escalating anything.', {}, async () => {
    const h = hc()
    const view = await h.crew.fleetView()
    const choices = h.decisions.list(false).map((d) => ({ id: d.id, key: d.key, task: d.taskId, q: d.question, until: d.until }))
    return ok(`${view}\n\nOPEN CHOICES (${choices.length})\n${json(choices)}`)
  })

  t('unit_state', 'Current state of one unit, reconciled from its live terminal, status log and PR (status lines are events, this is the truth).', { task: z.string() }, async ({ task }) => {
    const f = requireTask(task)
    const line = await f.hc.crew.crewState(task)
    return ok(`${line}\n${json(taskLine(f.task))}`)
  })

  t(
    'read_task_file',
    "Read a unit's instructions (brief), Recon report, status log, inbox, diff against base, terminal log, or Gauntlet log. For a linked report appendix, pass appendix=its relative path inside the task data folder and which=report.",
    { task: z.string(), which: z.enum(['brief', 'report', 'status', 'inbox', 'diff', 'log', 'validation']), appendix: z.string().optional() },
    async ({ task, which, appendix }) => {
      const f = requireTask(task)
      if (appendix) {
        if (which !== 'report') return fail('appendix is only supported for report reads')
        return ok(readReference(f.hc.home.taskDir(task), appendix))
      }
      const txt = await f.hc.crew.readFile(task, which as TaskFile)
      return ok(txt || '(empty)')
    }
  )

  t('terminal_tail', "Last N lines of a unit's live terminal, ANSI stripped.", { task: z.string(), lines: z.number().int().min(1).max(400).default(60) }, async ({ task, lines }) => {
    const f = requireTask(task)
    if (!f.task.terminalId || !getCtx().terminals.get(f.task.terminalId)) return ok('(no live terminal for this unit)')
    return ok(getCtx().terminals.tail(f.task.terminalId, lines) || '(no output yet)')
  })

  t(
    'deploy',
    'Deploy a unit on a Build (kind=ship: produces a change) or Recon (kind=scout: produces a report) mission in an isolated copy of a project. intent = the player\'s own words (no speaker labels); spec = only the build instructions the ask requires. category = what kind of work it is (drives the category table). mode/auto_loot default to the project posture (resolve with world_posture first). Files a quest automatically unless quest_id is given. Omit harness/model/effort to let the loadout picker choose (rules, the Usage mode, category table, quota protection, learning); preview it with loadout_preview.',
    {
      kind: z.enum(['ship', 'scout']),
      world: z.string(),
      title: z.string().min(3),
      intent: z.string().min(3),
      spec: z.string().optional(),
      category: z.enum(CATEGORY_IDS).optional(),
      mode: z.enum(['no-mistakes', 'direct-PR', 'local-only']).optional(),
      auto_loot: z.boolean().optional(),
      base_branch: z.string().optional(),
      harness: z.string().optional(),
      model: z.string().optional(),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
      quest_id: z.string().optional()
    },
    async (a) => {
      if (/^\s*(captain|player|boss)\b[:,]/i.test(a.intent)) return fail('intent must be the player\'s words without a speaker label or direct address')
      try {
        const owner = a.quest_id ? questHome(a.quest_id) : hc()
        const task = await owner.crew.spawn({
          kind: a.kind, project: a.world, title: a.title, intent: a.intent, spec: a.spec, mode: a.mode, yolo: a.auto_loot,
          baseBranch: a.base_branch, harness: a.harness, model: a.model, effort: a.effort, category: a.category, backlogId: a.quest_id, wksp: owner.home.name
        })
        return ok(`deployed ${task.id}: ${task.kind === 'ship' ? 'Build' : 'Recon'} "${task.title}" in ${task.project} (unit tool ${task.harness}${task.model ? ` / ${task.model}` : ''}${task.effort ? ` / ${task.effort}` : ''}, mode ${modeLabel(task.mode)}, branch ${task.branch})${task.loadout?.length ? `\nloadout reasons:\n- ${task.loadout.join('\n- ')}` : ''}`)
      } catch (e) {
        const msg = (e as Error).message ?? String(e)
        if (/deferred|capacity/i.test(msg)) return ok(`deferred: ${msg}. The quest stays queued; it will be dispatchable when capacity frees up.`)
        return fail(`deploy refused: ${msg}`)
      }
    }
  )

  t(
    'ping',
    "Steer a unit: writes a durable message into its steering inbox and rings its terminal. Pass resolve_keys when this answers an open keyed choice/blocker. Never use for lifecycle (use control).",
    { task: z.string(), text: z.string().min(1), resolve_keys: z.array(z.string()).optional() },
    async ({ task, text, resolve_keys }) => {
      const f = requireTask(task)
      const r = await f.hc.crew.send(task, text, resolve_keys)
      if (r.ok && resolve_keys?.length) for (const k of resolve_keys) f.hc.decisions.resolveKey(task, k, text)
      return r.ok ? ok(r.message || 'pinged') : fail(r.message)
    }
  )

  t(
    'control',
    'Unit lifecycle: interrupt, exit (recall), relaunch (respawn in the same copy and session). Never tears anything down. Chat relaunches are deliberate, like the UI Respawn button, and reset the automatic retry limit; Bot recovery is capped at one retry. Quota and capacity safeguards still apply.',
    { task: z.string(), action: z.enum(['interrupt', 'exit', 'relaunch']), note: z.string().optional(), player_words: z.string().trim().min(1).optional() },
    async ({ task, action, note, player_words }) => {
      if (role === 'bot' && player_words) return fail('The Bot cannot authorize a manual restart')
      const f = requireTask(task)
      const r = await f.hc.crew.control(task, action, note, role !== 'bot')
      return r.ok ? ok(r.message || `${action} done`) : fail(r.message)
    }
  )

  t(
    'despawn',
    'Despawn a unit and remove its isolated copy. Refuses unlanded work (uncommitted changes, commits not pushed/merged) and lists the exact files/commits. A Recon that has exited (recalled or duplicate) needs no report. force=true discards work and REQUIRES player_words quoting the player\'s explicit instruction to discard this specific work.',
    { task: z.string(), force: z.boolean().default(false), player_words: z.string().optional() },
    async ({ task, force, player_words }) => {
      if (force && (role === 'bot' || !player_words?.trim())) return fail('force despawn refused: it needs the player\'s explicit words authorizing discarding this work')
      const f = requireTask(task)
      const r = await f.hc.crew.cleanup(task, force)
      return r.ok ? ok(r.message || 'despawned') : fail(`despawn refused: ${r.message}`)
    }
  )

  t(
    'merge',
    "Merge a Build: its PR (guarded squash merge of a green, non-draft PR) or, for Offline projects, a fast-forward of its ready branch. Without the project's Auto-loot, player_words must quote the player's explicit approval of this merge.",
    { task: z.string(), player_words: z.string().optional() },
    async ({ task, player_words }) => {
      const ctx = getCtx()
      const f = requireTask(task)
      const tk = f.task
      if (tk.kind !== 'ship') return fail('only Build missions can be merged')
      const proj = ctx.projects.get(tk.project)
      const autoLoot = tk.yolo ?? proj?.yolo ?? false
      const words = role === 'bot' ? '' : (player_words ?? '').trim()
      if (!autoLoot && !words) return fail('merge refused: this project has no Auto-loot, so it needs the player\'s explicit approval (pass their words as player_words, or open a choice)')
      const away = ctx.away.state().mode
      if (tk.mode === 'local-only' && away === 'afk') return fail('merge refused: Offline landings wait for the player to return from AFK')
      if (tk.pr?.url) {
        const v = await ctx.forge.view(tk.pr.url, tk.worktree)
        if (!v.ok) return fail(`could not read the PR: ${v.message ?? 'unknown error'}`)
        if (v.isDraft) return fail('merge refused: the PR is a draft')
        if (v.checks === 'failing') return fail(`merge refused: checks are red (${v.failing.join(', ') || 'failing'})`)
        if (v.checks === 'pending') return fail(`merge refused: checks still running (${v.pending.join(', ') || 'pending'})`)
      }
      const r = await f.hc.crew.merge(task)
      return r.ok ? ok(r.message || 'merged') : fail(`merge refused: ${r.message}`)
    }
  )

  t('upgrade_recon', 'Upgrade a finished Recon into a Build in place (the report becomes context). intent = the player\'s words for what to build.', { task: z.string(), intent: z.string().optional() }, async ({ task, intent }) => {
    const f = requireTask(task)
    const nt = await f.hc.crew.promote(task, intent)
    return ok(`upgraded to Build ${nt.id} (${modeLabel(nt.mode)}, branch ${nt.branch})`)
  })

  t('run_gauntlet', 'Run (or re-run) the Gauntlet on a Hardcore Build: review → fix rounds → project checks → push → PR → CI.', { task: z.string() }, async ({ task }) => {
    const f = requireTask(task)
    const r = await f.hc.crew.validate(task)
    return r.ok ? ok(r.message || 'Gauntlet started') : fail(r.message)
  })

  // ------------------------------------------------------------ quest log
  t('quest_list', 'Quest log for this base in dispatch order (priority, manual rank, age): queued (waiting=the player must act, duplicate_of=flagged duplicate), in-flight, done.', { include_done: z.boolean().default(false) }, async ({ include_done }) => {
    const h = hc()
    const items = h.backlog.list().filter((i) => include_done || !['done', 'dropped'].includes(i.state)).sort(questOrder)
    return ok(json(items.map((i) => ({ ...i, bucket: h.backlog.bucket(i), ...(i.hold ? { waiting: 'for the player' } : {}) }))))
  })

  t(
    'quest_add',
    'File a quest (work item). kind: ship (Build), scout (Recon), choice (a decision waiting for the player). Programs are retired: kind=program files no quest and returns a label; put it in tags on the related quests.',
    {
      title: z.string().min(3),
      world: z.string().optional(),
      kind: z.enum(['ship', 'scout', 'choice', 'program']).default('ship'),
      notes: z.string().default(''),
      priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
      depends_on: z.array(z.string()).default([]),
      not_before: z.string().optional(),
      tags: z.array(z.string()).default([])
    },
    async (a) => {
      if (a.kind === 'program') {
        const label = a.tags[0] || slugify(a.title, 32)
        return ok(`programs are labels now: no quest filed. Tag the quests that belong to "${a.title}" with "${label}" (quest_add/quest_update tags).`)
      }
      const it = hc().backlog.add({ title: a.title, project: a.world, kind: a.kind, notes: a.notes, priority: a.priority, dependsOn: a.depends_on, notBefore: a.not_before, tags: a.tags })
      return ok(`quest ${it.id} filed (${it.state})${it.duplicateOf ? `; flagged as a duplicate of ${it.duplicateOf} and not dispatched until cleared (quest_update duplicate_of="")` : ''}`)
    }
  )

  t(
    'quest_update',
    "Update a quest's notes/title/priority/rank/dependencies/project/tags. rank orders quests within a priority (1 runs first). state=held flags it as waiting for the player (it stays queued). duplicate_of=\"\" clears a duplicate flag. Inspect the current note first; replace the considered body rather than appending by default.",
    {
      id: z.string(), title: z.string().optional(), notes: z.string().optional(),
      priority: z.enum(['low', 'normal', 'high', 'critical']).optional(), rank: z.number().int().min(1).optional(),
      depends_on: z.array(z.string()).optional(), tags: z.array(z.string()).optional(),
      world: z.string().optional(), not_before: z.string().optional(), duplicate_of: z.string().optional(),
      state: z.enum(['queued', 'blocked', 'dropped', 'held']).optional()
    },
    async (a) => {
      const patch: Record<string, unknown> = {}
      if (a.title !== undefined) patch.title = a.title
      if (a.notes !== undefined) patch.notes = a.notes
      if (a.priority !== undefined) patch.priority = a.priority
      if (a.rank !== undefined) patch.rank = a.rank
      if (a.depends_on !== undefined) patch.dependsOn = a.depends_on
      if (a.tags !== undefined) patch.tags = a.tags
      if (a.world !== undefined) patch.project = a.world
      if (a.not_before !== undefined) patch.notBefore = a.not_before
      if (a.duplicate_of !== undefined) patch.duplicateOf = a.duplicate_of
      if (a.state !== undefined) patch.state = a.state
      const it = questHome(a.id).backlog.update(a.id, patch)
      return ok(`quest ${it.id} updated (${it.state}${it.hold ? ', waiting for the player' : ''})`)
    }
  )

  t('quest_hold', 'Flag a quest as waiting for the player (a choice only they can make); it stays queued, or in flight with its unit. until=YYYY-MM-DD defers it ("later").', { id: z.string(), reason: z.string().min(3), until: z.string().optional() }, async ({ id, reason, until }) => {
    const it = questHome(id).backlog.hold(id, reason, until)
    return ok(`quest ${it.id} ${it.state}, waiting for the player: ${reason}${until ? ` until ${until}` : ''}`)
  })

  t("quest_answer", "Record the player's exact words on a quest waiting for them. release=true clears the wait so the work proceeds; false closes it.", { id: z.string(), words: z.string().min(1), release: z.boolean().default(true) }, async ({ id, words, release }) => {
    const it = questHome(id).backlog.answer(id, words, release)
    return ok(`answer recorded on ${it.id} (${it.state})`)
  })

  t('quest_release', 'Release a player hold so the quest can be dispatched.', { id: z.string() }, async ({ id }) => {
    const it = questHome(id).backlog.release(id)
    return ok(`quest ${it.id} released (${it.state})`)
  })

  t('quest_remove', 'Remove a quest from the log (only for mistakes/duplicates; prefer state=dropped).', { id: z.string() }, async ({ id }) => {
    questHome(id).backlog.remove(id)
    return ok(`quest ${id} removed`)
  })

  // ------------------------------------------------------------ choices
  t(
    'choice_open',
    'Open a choice for the player in the pending answer panel (several options with a recommendation, or a design pick). Link task when it came from a unit.',
    {
      question: z.string().min(5), options: z.array(z.string()).default([]), recommendation: z.string().optional(), batch: z.string().optional(),
      context: z.string().optional(), task: z.string().optional(), key: z.string().optional(), quest_id: z.string().optional(),
      urgency: z.enum(['normal', 'urgent']).default('normal')
    },
    async (a) => {
      const h = a.task ? findTask(getCtx(), a.task, home)!.hc : hc()
      const project = getCtx().allies.list().find(ally => ally.name === home.name)?.projects[0]
      const d = a.task
        ? h.decisions.openForTask(a.task, a.key ?? 'default', a.question, role === 'bot' ? 'genio' : 'genio', {
            options: a.options, recommendation: a.recommendation, batch: a.batch, context: a.context, urgency: a.urgency, backlogId: a.quest_id
          })
        : h.decisions.open({ question: a.question, options: a.options, recommendation: a.recommendation, batch: a.batch, context: a.context, urgency: a.urgency, backlogId: a.quest_id, project, key: a.key, source: 'genio', wksp: home.name })
      return ok(`choice ${d.id} opened`)
    }
  )

  t('choice_resolve', "Close a choice with the player's answer (pings the unit with resolve key and records it on a held quest).", { id: z.string(), answer: z.string().min(1) }, async ({ id, answer }) => {
    if (role === 'bot') return fail('only the player can answer a choice; it stays open until they return')
    const found = findDecision(getCtx(), id)
    if (!home.isMain && found?.hc.home.name !== home.name) return fail('Choice is outside this conversation.')
    const r = await answerChoice(getCtx(), id, answer, { via: 'chat', chat: home.name })
    return r.ok ? ok(r.message) : fail(r.message)
  })

  t('choice_list', 'Open choices in this base; include_resolved for history.', { include_resolved: z.boolean().default(false) }, async ({ include_resolved }) => {
    return ok(json(hc().decisions.list(include_resolved)))
  })

  // ------------------------------------------------------------ worlds
  t('world_list', 'Registered projects: path, engine, engineSummary (engine, version, root, other candidates, ambiguity), posture (mode, Auto-loot, branch prefix), capacity, commands.', {}, async () => {
    return ok(json(getCtx().projects.list().map((p) => ({ ...p, modeLabel: modeLabel(p.mode), engineSummary: projectEngineSummary(p) }))))
  })

  t(
    'world_engine_root',
    "Pin which folder holds the project's game by writing .genio/project.json { engineRoot } in the repo (uncommitted). The escape hatch for monorepos, ambiguous detection and false positives. ONLY on the player's explicit instruction: player_words must quote it. root is repository-relative ('' = the repository root) and must hold an engine marker. Never on your own judgment, never for the Bot.",
    { world: z.string(), root: z.string(), player_words: z.string().trim().min(1) },
    async (a) => {
      if (role === 'bot') return fail('pinning the engine root waits for the player')
      return ok(await declareEngineRoot(getCtx(), { world: a.world, root: a.root, playerWords: a.player_words, actor: role }))
    }
  )

  t('world_posture', 'Resolve the concrete delivery posture for a Build in a project. surface=product|internal matters for Hardcore (prod) projects.', { world: z.string(), surface: z.enum(['product', 'internal']).optional() }, async ({ world, surface }) => {
    return ok(json(getCtx().projects.resolvePosture(world, { surface })))
  })

  t(
    'world_add',
    'Register a project: clone a git URL / owner/repo, or register a local folder in place (in_place=true). Omit mode to let it follow the remote (none/other → Offline, GitHub → Standard); a mode you pass is pinned. Confirm name, source and posture with the player first.',
    {
      source: z.string(), name: z.string().optional(),
      mode: z.enum(['no-mistakes', 'direct-PR', 'local-only', 'no-mistakes-prod-only']).optional(),
      auto_loot: z.boolean().optional(), branch_prefix: z.string().optional(), capacity: z.number().int().min(0).optional(), in_place: z.boolean().optional()
    },
    async (a) => {
      if (a.auto_loot && role === 'bot') return fail('Auto-loot is only granted by the player')
      const p = await getCtx().projects.add({ source: a.source, name: a.name, mode: a.mode, yolo: a.auto_loot, branchPrefix: a.branch_prefix, capacity: a.capacity, inPlace: a.in_place })
      return ok(`project ${p.name} registered (${p.engine}, ${modeLabel(p.mode)}${p.yolo ? ' +auto-loot' : ''}) at ${p.path}`)
    }
  )

  t(
    'world_create',
    'Create a new game project (git init with an engine scaffold: .gitignore, README, AGENTS.md). The engine is not pinned: Genio detects it once its project files exist. create_remote makes a GitHub repo too and REQUIRES player_words with their explicit consent to the name and visibility.',
    {
      name: z.string(), engine: z.enum(['godot', 'unity', 'unreal', 'bevy', 'web', 'love2d', 'gamemaker', 'defold', 'monogame', 'other']),
      description: z.string().optional(), mode: z.enum(['no-mistakes', 'direct-PR', 'local-only', 'no-mistakes-prod-only']).optional(),
      create_remote: z.boolean().default(false), private_remote: z.boolean().default(true), player_words: z.string().optional()
    },
    async (a) => {
      if (a.create_remote && (role === 'bot' || !a.player_words?.trim())) return fail('creating a remote repo is outward-facing: it needs the player\'s explicit consent (player_words)')
      const p = await getCtx().projects.create({ name: a.name, engine: a.engine, description: a.description, mode: a.mode, createRemote: a.create_remote, privateRemote: a.private_remote })
      return ok(`project ${p.name} created at ${p.path} (${a.engine} scaffold, detected engine ${p.engine}, ${modeLabel(p.mode)})`)
    }
  )

  t(
    'world_update',
    'Change a project\'s registry entry: mode (pins it; mode=auto makes it follow the remote again), Auto-loot (only on the player\'s word), branch prefix, capacity, engine commands (setup/build/test/lint/run), description. The engine and its root are detected, never set here.',
    {
      world: z.string(), mode: z.enum(['no-mistakes', 'direct-PR', 'local-only', 'no-mistakes-prod-only', 'auto']).optional(),
      auto_loot: z.boolean().optional(), player_words: z.string().optional(), branch_prefix: z.string().optional(),
      capacity: z.number().int().min(0).optional(), description: z.string().optional(),
      commands: z.object({ setup: z.string().optional(), build: z.string().optional(), test: z.string().optional(), lint: z.string().optional(), run: z.string().optional() }).optional()
    },
    async (a) => {
      if (a.auto_loot === true && (role === 'bot' || !a.player_words?.trim())) return fail('Auto-loot is granted only on the player\'s explicit word (player_words)')
      const patch: Record<string, unknown> = {}
      if (a.mode === 'auto') patch.modeSource = 'auto'
      else if (a.mode) patch.mode = a.mode
      if (a.auto_loot !== undefined) patch.yolo = a.auto_loot
      if (a.branch_prefix !== undefined) patch.branchPrefix = a.branch_prefix
      if (a.capacity !== undefined) patch.capacity = a.capacity
      if (a.description !== undefined) patch.description = a.description
      if (a.commands) {
        const cur = getCtx().projects.get(a.world)?.commands ?? {}
        patch.commands = { ...cur, ...a.commands }
      }
      const p = getCtx().projects.update(a.world, patch)
      return ok(`project ${p.name} updated: ${modeLabel(p.mode)}${p.yolo ? ' +auto-loot' : ''}, prefix ${p.branchPrefix}`)
    }
  )

  t('world_remove', 'Unregister a project (preflight refuses while units/quests are live or work is unlanded). delete_clone deletes Genio\'s clone and REQUIRES player_words.', { world: z.string(), delete_clone: z.boolean().default(false), player_words: z.string().optional() }, async (a) => {
    if (role === 'bot') return fail('removing projects waits for the player')
    if (a.delete_clone && !a.player_words?.trim()) return fail('deleting a clone needs the player\'s explicit words')
    const r = await getCtx().projects.remove(a.world, a.delete_clone)
    return r.ok ? ok(r.message) : fail(r.message)
  })

  t('world_sync', "Guarded sync of a project's main copy (re-detect the remote, fast-forward default branch, prune merged gone branches; Offline projects only fetch). Omit project for all.", { world: z.string().optional() }, async ({ world }) => {
    const r = await getCtx().projects.sync(world)
    return r.ok ? ok(r.message) : fail(r.message)
  })

  t(
    'world_push',
    "Push on demand for an Offline project with a remote: pushes the default branch (or `branch`) to origin, reporting ahead/behind first. A plain fast-forward push only: refuses when origin has diverged, never forces. Outward-facing: only on the player's request.",
    { world: z.string(), branch: z.string().optional() },
    async ({ world, branch }) => {
      if (role === 'bot') return fail('pushing waits for the player: it is outward-facing')
      const r = await getCtx().projects.push(world, branch)
      return r.ok ? ok(r.message) : fail(r.message)
    }
  )

  // ------------------------------------------------------------ status, memory, mail
  t('status_report', 'The four-section status report (Your Move, Loot, In Progress, Up Next). include_prs adds live GitHub PR enrichment; file=true also saves today\'s report.', { include_prs: z.boolean().default(false), file: z.boolean().default(false) }, async ({ include_prs, file }) => {
    const r = await getCtx().statusReport.generate({ file, includePRs: include_prs })
    return ok(`${r.markdown}${r.filedPath ? `\n\n(saved to ${r.filedPath})` : ''}`)
  })

  const memEnum = home.isMain ? z.enum(['player', 'player-shared', 'lore']) : z.enum(['player', 'player-shared', 'lore'])
  t('memory_read', 'Read versioned memory. which: player = player profile, player-shared = shared profile, lore = squad memory (call it squad memory to the player). since=the previous version returns unchanged or a character splice (start, deleteCount, insert); apply it to that version. Unknown versions return a full snapshot with reset=true. Finish all pages before using a version. full=true ignores since.', { which: memEnum, since: z.string().optional(), full: pageShape.full }, async ({ which, since, full }) => ok(json(getCtx().memory.readVersion(which, full ? undefined : since, home))))
  t('memory_write', 'Replace a memory file with curated content (keep markers <!--P-->, <!--a:DATE-->, <!--p:DATE-->).', { which: memEnum, content: z.string() }, async ({ which, content }) => {
    getCtx().memory.write(which, content, home)
    return ok(`${which === 'lore' ? 'squad memory' : which} saved`)
  })
  t('memory_report', 'Memory budget (estimated tokens), per-file size and expired entries.', {}, async () => ok(json(getCtx().memory.report(home))))
  t('memory_archive', 'Move entries (exact lines) out of memory files into the archive with a reason.', { entries: z.array(z.string()).min(1), reason: z.string() }, async ({ entries, reason }) => {
    getCtx().memory.archive(entries, reason, home)
    return ok(`archived ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`)
  })

  t('mail_list', "Mail the player sent from elsewhere (phone, scripts). Handle, then mail_ack; mail_reply when they need a durable answer.", {}, async () => ok(json(getCtx().inbox.list())))
  t('mail_ack', 'Acknowledge a handled mail note.', { id: z.string() }, async ({ id }) => {
    getCtx().inbox.ack(id)
    return ok(`mail ${id} acknowledged`)
  })
  t('mail_reply', 'Publish a durable reply to a mail note (one per note).', { id: z.string(), text: z.string().min(1) }, async ({ id, text }) => {
    getCtx().inbox.reply(id, text)
    return ok(`replied to ${id}`)
  })

  // ------------------------------------------------------------ dispatch & tools
  t('dispatch_profiles', 'The Usage mode and what it resolves to (protection levels, unit cap, quests waiting for a reset), dispatch rules, the category table (locked rows are pinned; unlocked rows follow the mode), learned scores and the unit tools available on this machine (with models), plus pinned defaults. Consult at every deploy.', {}, async () => {
    const s = getCtx().settings
    const cfg = s.get()
    return ok(
      json({
        rules: cfg.dispatchRules,
        categoryTable: cfg.categoryPools.map((p) => ({ category: p.category, candidates: p.candidates, locked: p.locked || undefined })),
        usage: (({ meter: _m, notices: _n, ...v }) => v)(getCtx().dispatch.view()),
        scores: getCtx().dispatch.scores().rows.map((r) => ({ scope: r.scope, tool: r.harness, model: r.model, score: r.score, samples: r.samples })),
        default: { harness: cfg.defaultHarness, model: cfg.defaultWorkerModel || undefined, effort: cfg.defaultWorkerEffort || undefined },
        available: s.availableHarnesses().map((h) => ({ id: h.id, name: h.name, models: h.models, role: h.role, verified: h.verified }))
      })
    )
  })

  t(
    'loadout_preview',
    'What a deploy would get (unit tool, model, effort, category) if harness/model/effort are omitted or set as given, and why.',
    {
      kind: z.enum(['ship', 'scout']), world: z.string(), title: z.string(), intent: z.string(), spec: z.string().optional(),
      category: z.enum(CATEGORY_IDS).optional(), harness: z.string().optional(), model: z.string().optional(), effort: z.string().optional()
    },
    async (a) =>
      ok(
        json(
          resolveLoadout(
            { kind: a.kind, project: a.world, title: a.title, intent: a.intent, spec: a.spec, category: a.category, harness: a.harness, model: a.model, effort: a.effort },
            getCtx().settings,
            getCtx().dispatch.signals(a.world, { preview: true })
          )
        )
      )
  )

  t(
    'rate_task',
    "Record the player's verdict on how a unit did (up = good work, down = poor), with their words as the note. Feeds the dispatch scorecard.",
    { task: z.string(), verdict: z.enum(['up', 'down']), note: z.string().optional() },
    async ({ task, verdict, note }) => {
      if (role === 'bot') return fail('only the player rates units')
      const r = getCtx().dispatch.rate(task, verdict, note)
      return r.ok ? ok(r.message) : fail(r.message)
    }
  )

  t('toolchain_check', 'Which tools (git, gh, unit CLIs, engines) are installed. Missing tools are offered to the player; never installed without their consent.', {}, async () => {
    const list = await getCtx().toolchain.check()
    return ok(list.map((x) => `${x.found ? 'OK ' : 'MISSING'} ${x.name}${x.version ? ` ${x.version}` : ''} — ${x.purpose}${!x.found && x.install ? ` (install: ${x.install})` : ''}`).join('\n'))
  })

  t('presence_set', "Change the player's presence (online, dnd, afk) — only when the player asks.", { mode: z.enum(['online', 'dnd', 'afk']) }, async ({ mode }) => {
    if (role === 'bot') return fail('only the player changes presence')
    const st = await getCtx().away.set(mode)
    return ok(`presence: ${st.mode}`)
  })

  // ------------------------------------------------------------ allies
  if (home.isMain) {
    t('ally_list', 'Registered allies (allied Genios with their own base): scope, charter, projects.', {}, async () => ok(json(getCtx().allies.list().filter((a) => !a.retiredAt))))
    t('ally_route', "Route a request to the ally whose scope fits. Its reply returns as an 'ally' event, not by reading its chat.", { name: z.string(), request: z.string().min(3) }, async ({ name, request }) => {
      const r = await getCtx().allies.route(name, request)
      return r.ok ? ok(r.message) : fail(r.message)
    })
  } else {
    t(
      'report_to_main',
      'Ally only: report to main Genio (the only way to reach the player). verb: done | ready | needs-decision | blocked | failed | note. Echo the corr id of the request you answer.',
      { verb: z.enum(['done', 'ready', 'needs-decision', 'blocked', 'failed', 'note']), note: z.string().min(1), corr: z.string().optional() },
      async ({ verb, note, corr }) => {
        getCtx().allies.reportToParent(home.name, verb, note, corr)
        return ok('reported to main Genio')
      }
    )
  }

  if (role === 'bot') {
    t(
      'escalate',
      'Bot only: surface something the player must see (PR ready with full URL, finished findings, a choice only they can make, a real failure, a needed login). One per distinct outcome.',
      { text: z.string().min(3), severity: z.enum(['info', 'decision', 'failure', 'ready']).default('info') },
      async ({ text, severity }) => {
        hooks.escalate?.(text, severity)
        return ok('escalated')
      }
    )
  }

  // ------------------------------------------------------------ agent generation and guarded placement
  if (role !== 'bot') {
    t('fal_models', 'Browse the FAL catalogue by job or query; endpoint returns its current schema and price. Read before fal_generate.', { world: z.string(), job: z.string().optional(), query: z.string().optional(), endpoint: z.string().optional() }, async a => {
      const fal = getCtx().fal
      if (a.endpoint) return ok(json(await fal.model(a.endpoint)))
      const c = fal.catalogue(a.world)
      return ok(json({ ...c, entries: c.entries.filter(e => (!a.job || e.job === a.job) && (!a.query || JSON.stringify(e).toLowerCase().includes(a.query.toLowerCase()))) }))
    })
    t('fal_generate', 'Generate FAL media in the background. Follow assets skill: asset_locate, then pass place and the player request. Quote card above threshold; monthly cap is a hard stop. Up to four outputs, $2 maximum; delegate larger work.', falGenerateShape, async a => ok(json(await agentGeneration(getCtx()).fal(home.name, a, role))))
    t('uthana_motion', 'Generate a motion in the background. Stock Manny humanoid by default; FBX for Unity, GLB otherwise. Follow assets and uthana skills; no import settings are changed.', uthanaMotionShape, async a => ok(json(await agentGeneration(getCtx()).motion(home.name, a, role))))
    t('uthana_character', 'Reuse an uploaded character by project source and sha256, or upload this project-relative FBX/GLB. Prefer stock humanoids; rigging can cost $0.15.', uthanaCharacterShape, async a => ok(json(await agentGeneration(getCtx()).character(home.name, a, role))))
    t('asset_place', 'Place a generated run output in its project, uncommitted, with provenance. Media only. Never Bot, forbidden dirs or vendor packs. Requires player_words; overwriting additionally requires overwrite_words quoting explicit confirmation for that file.', assetPlaceShape, async a => ok(json(await agentGeneration(getCtx()).place(home.name, a, role))))
    t('approve_run', 'Approve the exact pending quote in this chat only when the player agrees; quote their words. Cannot override the monthly cap.', { run: z.string(), player_words: z.string().trim().min(1) }, async a => ok(json(await agentGeneration(getCtx()).approve(a.run, home.name, a.player_words, role))))
    t('generation_status', 'Inspect a background generation and its saved paths or error. Never resubmit uncertain jobs.', { run: z.string() }, a => ok(json(agentGeneration(getCtx()).status(a.run, home.name))))
    t('generate_image', GENERATE_IMAGE_DESC, generateImageShape, async (a) => ok(json(await agentGeneration(getCtx()).image(home.name, a, role))))
  }

  return tools
}

// Compatibility entry point; SDK-specific adaptation lives in its own module.
export { buildTools } from './wksp-sdk-tools'
