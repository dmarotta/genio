/**
 * Genio's in-process MCP toolbelt (mcp__genio__*). Every mechanic is a
 * deterministic service call; the agent only supplies judgment. Guards that
 * companion enforced in scripts (merge authority, despawn force, outward
 * consent) are enforced here too, so a confused model cannot bypass them.
 */
import { z } from 'zod'
import { modeLabel } from '@shared/vocab'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { Decision, Task } from '@shared/types'
import type { TaskFile } from '@shared/api'
import type { AppCtx, HomeCtx } from './services'
import type { Home } from './home'
import { truncate } from './util'
import { resolveLoadout } from './loadout'
import { GENERATE_IMAGE_DESC, chatImageGen, generateChatImages, generateImageShape } from './chat-imagegen'

type ToolFn = typeof import('@anthropic-ai/claude-agent-sdk').tool

export type ToolRole = 'genio' | 'bot'

export interface ToolHooks {
  /** Bot only: surface something the player must see */
  escalate?: (text: string, severity: 'info' | 'decision' | 'failure' | 'ready') => void
}

const ok = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true })
const json = (v: unknown): string => JSON.stringify(v, null, 1)

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
export async function answerChoice(ctx: AppCtx, id: string, answer: string): Promise<{ ok: boolean; message: string }> {
  const found = findDecision(ctx, id)
  if (!found) return { ok: false, message: `no choice ${id}` }
  const { hc, d } = found
  if (d.resolvedAt) return { ok: true, message: 'already answered' }
  let note = ''
  if (d.taskId) {
    const t = findTask(ctx, d.taskId, hc.home)
    if (t && !['cleaned', 'done', 'merged'].includes(t.task.state)) {
      const r = await t.hc.crew.send(d.taskId, `Answer to your open question (${d.key}): ${answer}`, [d.key])
      note = r.ok ? ' and pinged the unit' : ` (ping failed: ${r.message})`
    }
  }
  if (d.backlogId && hc.backlog.get(d.backlogId)) {
    try {
      hc.backlog.answer(d.backlogId, answer, true)
    } catch {
      /* quest may already be closed */
    }
  }
  hc.decisions.resolve(id, answer)
  try {
    ctx.stats.award('decision', d.taskId)
  } catch {
    /* stats optional */
  }
  return { ok: true, message: `choice answered${note}` }
}

function taskLine(t: Task): Record<string, unknown> {
  return {
    id: t.id, kind: t.kind === 'ship' ? 'build' : 'recon', title: t.title, world: t.project, state: t.state,
    reason: t.stateReason, mode: t.mode, autoLoot: t.yolo, branch: t.branch, pr: t.pr?.url, checks: t.pr?.checks,
    unitTool: t.harness, model: t.model, effort: t.effort, base: t.wksp
  }
}

export function buildTools(
  tool: ToolFn,
  getCtx: () => AppCtx,
  home: Home,
  role: ToolRole,
  hooks: ToolHooks = {}
): SdkMcpToolDefinition<any>[] {
  const hc = (): HomeCtx => getCtx().home(home.name)
  const tools: SdkMcpToolDefinition<any>[] = []

  // Wrap every handler so a thrown error becomes a tool error, never a crash.
  function t<S extends z.ZodRawShape>(name: string, desc: string, shape: S, fn: (a: z.infer<z.ZodObject<S>>) => Promise<CallToolResult> | CallToolResult): void {
    tools.push(
      tool(name, desc, shape, async (args: unknown) => {
        try {
          return await fn(args as z.infer<z.ZodObject<S>>)
        } catch (e) {
          return fail(`${name} failed: ${(e as Error)?.message ?? String(e)}`)
        }
      })
    )
  }

  const requireTask = (id: string): { hc: HomeCtx; task: Task } => {
    const f = findTask(getCtx(), id, home)
    if (!f) throw new Error(`no unit/mission with id "${id}"`)
    return f
  }

  // ------------------------------------------------------------ squad
  t('fleet_view', 'Squad view: every unit in this base (state, world, PR, artifact), plus queued/held quests and open choices. Use at session start, on ticks, and before re-escalating anything.', {}, async () => {
    const h = hc()
    const view = await h.crew.fleetView()
    const choices = h.decisions.list(false).map((d) => ({ id: d.id, key: d.key, task: d.taskId, q: truncate(d.question, 200), until: d.until }))
    return ok(`${view}\n\nOPEN CHOICES (${choices.length})\n${json(choices)}`)
  })

  t('unit_state', 'Current state of one unit, reconciled from its live terminal, status log and PR (status lines are events, this is the truth).', { task: z.string() }, async ({ task }) => {
    const f = requireTask(task)
    const line = await f.hc.crew.crewState(task)
    return ok(`${line}\n${json(taskLine(f.task))}`)
  })

  t(
    'read_task_file',
    "Read a unit's instructions (brief), Recon report, status log, inbox, diff against base, terminal log, or Gauntlet log.",
    { task: z.string(), which: z.enum(['brief', 'report', 'status', 'inbox', 'diff', 'log', 'validation']) },
    async ({ task, which }) => {
      const f = requireTask(task)
      const txt = await f.hc.crew.readFile(task, which as TaskFile)
      return ok(truncate(txt || '(empty)', 60_000))
    }
  )

  t('terminal_tail', "Last N lines of a unit's live terminal, ANSI stripped.", { task: z.string(), lines: z.number().int().min(1).max(400).default(60) }, async ({ task, lines }) => {
    const f = requireTask(task)
    if (!f.task.terminalId || !getCtx().terminals.get(f.task.terminalId)) return ok('(no live terminal for this unit)')
    return ok(getCtx().terminals.tail(f.task.terminalId, lines) || '(no output yet)')
  })

  t(
    'deploy',
    'Deploy a unit on a Build (kind=ship: produces a change) or Recon (kind=scout: produces a report) mission in an isolated copy of a world. intent = the player\'s own words (no speaker labels); spec = only the build instructions the ask requires. mode/auto_loot default to the world posture (resolve with world_posture first). Files a quest automatically unless quest_id is given. Omit harness/model/effort to let the loadout picker choose (dispatch rules, defaults, effort from the ask); preview it with loadout_preview.',
    {
      kind: z.enum(['ship', 'scout']),
      world: z.string(),
      title: z.string().min(3),
      intent: z.string().min(3),
      spec: z.string().optional(),
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
        const task = await hc().crew.spawn({
          kind: a.kind, project: a.world, title: a.title, intent: a.intent, spec: a.spec, mode: a.mode, yolo: a.auto_loot,
          baseBranch: a.base_branch, harness: a.harness, model: a.model, effort: a.effort, backlogId: a.quest_id, wksp: home.name
        })
        return ok(`deployed ${task.id}: ${task.kind === 'ship' ? 'Build' : 'Recon'} "${task.title}" in ${task.project} (unit tool ${task.harness}${task.model ? ` / ${task.model}` : ''}${task.effort ? ` / ${task.effort}` : ''}${task.loadout?.length ? ` — ${task.loadout.join('; ')}` : ''}, mode ${modeLabel(task.mode)}, branch ${task.branch})`)
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
    'Unit lifecycle: interrupt (stop the current action), exit (recall the unit), relaunch (respawn in the same isolated copy, resuming its conversation; note is appended to its instructions as a progress note). Never tears anything down.',
    { task: z.string(), action: z.enum(['interrupt', 'exit', 'relaunch']), note: z.string().optional() },
    async ({ task, action, note }) => {
      const f = requireTask(task)
      const r = await f.hc.crew.control(task, action, note)
      return r.ok ? ok(r.message || `${action} done`) : fail(r.message)
    }
  )

  t(
    'despawn',
    'Despawn a unit and remove its isolated copy. Refuses unlanded work (uncommitted changes, commits not pushed/merged). force=true discards work and REQUIRES player_words quoting the player\'s explicit instruction to discard this specific work.',
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
    "Merge a Build: its PR (guarded squash merge of a green, non-draft PR) or, for Offline worlds, a fast-forward of its ready branch. Without the world's Auto-loot, player_words must quote the player's explicit approval of this merge.",
    { task: z.string(), player_words: z.string().optional() },
    async ({ task, player_words }) => {
      const ctx = getCtx()
      const f = requireTask(task)
      const tk = f.task
      if (tk.kind !== 'ship') return fail('only Build missions can be merged')
      const proj = ctx.projects.get(tk.project)
      const autoLoot = tk.yolo ?? proj?.yolo ?? false
      const words = role === 'bot' ? '' : (player_words ?? '').trim()
      if (!autoLoot && !words) return fail('merge refused: this world has no Auto-loot, so it needs the player\'s explicit approval (pass their words as player_words, or open a choice)')
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

  t('run_gauntlet', 'Run (or re-run) the Gauntlet on a Hardcore Build: review → fix rounds → world checks → push → PR → CI.', { task: z.string() }, async ({ task }) => {
    const f = requireTask(task)
    const r = await f.hc.crew.validate(task)
    return r.ok ? ok(r.message || 'Gauntlet started') : fail(r.message)
  })

  // ------------------------------------------------------------ quest log
  t('quest_list', 'Quest log for this base: queued, in-flight, held, blocked, done.', { include_done: z.boolean().default(false) }, async ({ include_done }) => {
    const h = hc()
    const items = h.backlog.list().filter((i) => include_done || !['done', 'dropped'].includes(i.state))
    return ok(json(items.map((i) => ({ ...i, bucket: h.backlog.bucket(i) }))))
  })

  t(
    'quest_add',
    'File a quest (work item). kind: ship (Build), scout (Recon), choice (a decision held for the player), program (umbrella).',
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
      const it = hc().backlog.add({ title: a.title, project: a.world, kind: a.kind, notes: a.notes, priority: a.priority, dependsOn: a.depends_on, notBefore: a.not_before, tags: a.tags })
      return ok(`quest ${it.id} filed (${it.state})`)
    }
  )

  t(
    'quest_update',
    "Update a quest's notes/title/priority/dependencies/world. Inspect the current note first; replace the considered body rather than appending by default.",
    {
      id: z.string(), title: z.string().optional(), notes: z.string().optional(),
      priority: z.enum(['low', 'normal', 'high', 'critical']).optional(), depends_on: z.array(z.string()).optional(),
      world: z.string().optional(), not_before: z.string().optional(), state: z.enum(['queued', 'blocked', 'dropped']).optional()
    },
    async (a) => {
      const patch: Record<string, unknown> = {}
      if (a.title !== undefined) patch.title = a.title
      if (a.notes !== undefined) patch.notes = a.notes
      if (a.priority !== undefined) patch.priority = a.priority
      if (a.depends_on !== undefined) patch.dependsOn = a.depends_on
      if (a.world !== undefined) patch.project = a.world
      if (a.not_before !== undefined) patch.notBefore = a.not_before
      if (a.state !== undefined) patch.state = a.state
      const it = hc().backlog.update(a.id, patch)
      return ok(`quest ${it.id} updated (${it.state})`)
    }
  )

  t('quest_hold', 'Hold a quest for the player (a choice only they can make). until=YYYY-MM-DD defers it ("later").', { id: z.string(), reason: z.string().min(3), until: z.string().optional() }, async ({ id, reason, until }) => {
    const it = hc().backlog.hold(id, reason, until)
    return ok(`quest ${it.id} held: ${reason}${until ? ` until ${until}` : ''}`)
  })

  t("quest_answer", "Record the player's exact words on a held quest. release=true unholds the work so it proceeds; false closes it.", { id: z.string(), words: z.string().min(1), release: z.boolean().default(true) }, async ({ id, words, release }) => {
    const it = hc().backlog.answer(id, words, release)
    return ok(`answer recorded on ${it.id} (${it.state})`)
  })

  t('quest_release', 'Release a player hold so the quest can be dispatched.', { id: z.string() }, async ({ id }) => {
    const it = hc().backlog.release(id)
    return ok(`quest ${it.id} released (${it.state})`)
  })

  t('quest_remove', 'Remove a quest from the log (only for mistakes/duplicates; prefer state=dropped).', { id: z.string() }, async ({ id }) => {
    hc().backlog.remove(id)
    return ok(`quest ${id} removed`)
  })

  // ------------------------------------------------------------ choices
  t(
    'choice_open',
    'Open a choice for the player under Your Move (several options with a recommendation, or a design pick). Link task when it came from a unit.',
    {
      question: z.string().min(5), options: z.array(z.string()).default([]), recommendation: z.string().optional(),
      context: z.string().optional(), task: z.string().optional(), key: z.string().optional(), quest_id: z.string().optional(),
      urgency: z.enum(['normal', 'urgent']).default('normal')
    },
    async (a) => {
      const h = hc()
      const d = a.task
        ? h.decisions.openForTask(a.task, a.key ?? 'default', a.question, role === 'bot' ? 'genio' : 'genio', {
            options: a.options, recommendation: a.recommendation, context: a.context, urgency: a.urgency, backlogId: a.quest_id
          })
        : h.decisions.open({ question: a.question, options: a.options, recommendation: a.recommendation, context: a.context, urgency: a.urgency, backlogId: a.quest_id, key: a.key, source: 'genio', wksp: home.name })
      return ok(`choice ${d.id} opened`)
    }
  )

  t('choice_resolve', "Close a choice with the player's answer (pings the unit with resolve key and records it on a held quest).", { id: z.string(), answer: z.string().min(1) }, async ({ id, answer }) => {
    if (role === 'bot') return fail('only the player can answer a choice; it stays open until they return')
    const r = await answerChoice(getCtx(), id, answer)
    return r.ok ? ok(r.message) : fail(r.message)
  })

  t('choice_list', 'Open choices (Your Move) in this base; include_resolved for history.', { include_resolved: z.boolean().default(false) }, async ({ include_resolved }) => {
    return ok(json(hc().decisions.list(include_resolved)))
  })

  // ------------------------------------------------------------ worlds
  t('world_list', 'Registered worlds (projects): path, engine, posture (mode, Auto-loot, branch prefix), capacity, commands.', {}, async () => {
    return ok(json(getCtx().projects.list().map((p) => ({ ...p, modeLabel: modeLabel(p.mode) }))))
  })

  t('world_posture', 'Resolve the concrete delivery posture for a Build in a world. surface=product|internal matters for Hardcore (prod) worlds.', { world: z.string(), surface: z.enum(['product', 'internal']).optional() }, async ({ world, surface }) => {
    return ok(json(getCtx().projects.resolvePosture(world, { surface })))
  })

  t(
    'world_add',
    'Register a world: clone a git URL / owner/repo, or register a local folder in place (in_place=true). Confirm name, source and posture with the player first.',
    {
      source: z.string(), name: z.string().optional(),
      mode: z.enum(['no-mistakes', 'direct-PR', 'local-only', 'no-mistakes-prod-only']).optional(),
      auto_loot: z.boolean().optional(), branch_prefix: z.string().optional(), capacity: z.number().int().min(0).optional(), in_place: z.boolean().optional()
    },
    async (a) => {
      if (a.auto_loot && role === 'bot') return fail('Auto-loot is only granted by the player')
      const p = await getCtx().projects.add({ source: a.source, name: a.name, mode: a.mode, yolo: a.auto_loot, branchPrefix: a.branch_prefix, capacity: a.capacity, inPlace: a.in_place })
      return ok(`world ${p.name} registered (${p.engine}, ${modeLabel(p.mode)}${p.yolo ? ' +auto-loot' : ''}) at ${p.path}`)
    }
  )

  t(
    'world_create',
    'Create a new game world (git init with an engine scaffold). create_remote makes a GitHub repo too and REQUIRES player_words with their explicit consent to the name and visibility.',
    {
      name: z.string(), engine: z.enum(['godot', 'unity', 'unreal', 'bevy', 'web', 'love2d', 'gamemaker', 'defold', 'monogame', 'other']),
      description: z.string().optional(), mode: z.enum(['no-mistakes', 'direct-PR', 'local-only', 'no-mistakes-prod-only']).optional(),
      create_remote: z.boolean().default(false), private_remote: z.boolean().default(true), player_words: z.string().optional()
    },
    async (a) => {
      if (a.create_remote && (role === 'bot' || !a.player_words?.trim())) return fail('creating a remote repo is outward-facing: it needs the player\'s explicit consent (player_words)')
      const p = await getCtx().projects.create({ name: a.name, engine: a.engine, description: a.description, mode: a.mode, createRemote: a.create_remote, privateRemote: a.private_remote })
      return ok(`world ${p.name} created at ${p.path} (${p.engine}, ${modeLabel(p.mode)})`)
    }
  )

  t(
    'world_update',
    'Change a world\'s registry entry: mode, Auto-loot (only on the player\'s word), branch prefix, capacity, engine commands (setup/build/test/lint/run), description.',
    {
      world: z.string(), mode: z.enum(['no-mistakes', 'direct-PR', 'local-only', 'no-mistakes-prod-only']).optional(),
      auto_loot: z.boolean().optional(), player_words: z.string().optional(), branch_prefix: z.string().optional(),
      capacity: z.number().int().min(0).optional(), description: z.string().optional(),
      commands: z.object({ setup: z.string().optional(), build: z.string().optional(), test: z.string().optional(), lint: z.string().optional(), run: z.string().optional() }).optional()
    },
    async (a) => {
      if (a.auto_loot === true && (role === 'bot' || !a.player_words?.trim())) return fail('Auto-loot is granted only on the player\'s explicit word (player_words)')
      const patch: Record<string, unknown> = {}
      if (a.mode) patch.mode = a.mode
      if (a.auto_loot !== undefined) patch.yolo = a.auto_loot
      if (a.branch_prefix !== undefined) patch.branchPrefix = a.branch_prefix
      if (a.capacity !== undefined) patch.capacity = a.capacity
      if (a.description !== undefined) patch.description = a.description
      if (a.commands) {
        const cur = getCtx().projects.get(a.world)?.commands ?? {}
        patch.commands = { ...cur, ...a.commands }
      }
      const p = getCtx().projects.update(a.world, patch)
      return ok(`world ${p.name} updated: ${modeLabel(p.mode)}${p.yolo ? ' +auto-loot' : ''}, prefix ${p.branchPrefix}`)
    }
  )

  t('world_remove', 'Unregister a world (preflight refuses while units/quests are live or work is unlanded). delete_clone deletes Genio\'s clone and REQUIRES player_words.', { world: z.string(), delete_clone: z.boolean().default(false), player_words: z.string().optional() }, async (a) => {
    if (role === 'bot') return fail('removing worlds waits for the player')
    if (a.delete_clone && !a.player_words?.trim()) return fail('deleting a clone needs the player\'s explicit words')
    const r = await getCtx().projects.remove(a.world, a.delete_clone)
    return r.ok ? ok(r.message) : fail(r.message)
  })

  t('world_sync', "Guarded sync of a world's main copy (fast-forward default branch, prune merged gone branches). Omit world for all.", { world: z.string().optional() }, async ({ world }) => {
    const r = await getCtx().projects.sync(world)
    return r.ok ? ok(r.message) : fail(r.message)
  })

  // ------------------------------------------------------------ status, memory, mail
  t('status_report', 'The four-section status screen (Your Move, Loot, In Progress, Up Next). include_prs adds live GitHub PR enrichment; file=true also saves today\'s report.', { include_prs: z.boolean().default(false), file: z.boolean().default(false) }, async ({ include_prs, file }) => {
    const r = await getCtx().statusReport.generate({ file, includePRs: include_prs })
    return ok(`${r.markdown}${r.filedPath ? `\n\n(saved to ${r.filedPath})` : ''}`)
  })

  const memEnum = home.isMain ? z.enum(['player', 'player-shared', 'lore']) : z.enum(['player', 'player-shared', 'lore'])
  t('memory_read', 'Read a memory file: player (Player Profile), player-shared (inherited by allies), lore.', { which: memEnum }, async ({ which }) => ok(getCtx().memory.read(which, home) || '(empty)'))
  t('memory_write', 'Replace a memory file with curated content (keep markers <!--P-->, <!--a:DATE-->, <!--p:DATE-->).', { which: memEnum, content: z.string() }, async ({ which, content }) => {
    getCtx().memory.write(which, content, home)
    return ok(`${which} saved`)
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
  t('dispatch_profiles', 'Dispatch rules and the unit tools available on this machine (with models), plus defaults. Consult at every deploy.', {}, async () => {
    const s = getCtx().settings
    const cfg = s.get()
    return ok(
      json({
        rules: cfg.dispatchRules,
        default: { harness: cfg.defaultHarness, model: cfg.defaultWorkerModel || undefined, effort: cfg.defaultWorkerEffort || undefined },
        available: s.availableHarnesses().map((h) => ({ id: h.id, name: h.name, models: h.models, role: h.role, verified: h.verified }))
      })
    )
  })

  t(
    'loadout_preview',
    'What a deploy would get (unit tool, model, effort) if harness/model/effort are omitted or set as given, and why.',
    { kind: z.enum(['ship', 'scout']), world: z.string(), title: z.string(), intent: z.string(), spec: z.string().optional(), harness: z.string().optional(), model: z.string().optional(), effort: z.string().optional() },
    async (a) => ok(json(resolveLoadout({ kind: a.kind, project: a.world, title: a.title, intent: a.intent, spec: a.spec, harness: a.harness, model: a.model, effort: a.effort }, getCtx().settings)))
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
    t('ally_list', 'Registered allies (allied Genios with their own base): scope, charter, worlds.', {}, async () => ok(json(getCtx().allies.list().filter((a) => !a.retiredAt))))
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

  // ------------------------------------------------------------ images (Codex, ChatGPT plan; chat-only)
  if (role !== 'bot') {
    t('generate_image', GENERATE_IMAGE_DESC, generateImageShape, (a) => generateChatImages(chatImageGen(getCtx(), home), a))
  }

  return tools
}
