import { normalizeProjectArgs } from './project-tool-args'
import { z } from 'zod'
import path from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { chatControls } from '@shared/chat'
import type { AppCtx } from './services'
import type { Home } from './home'
import { agentGeneration } from './agent-generation'
import { createToolRegistry, findTask, findDecision, type ToolHooks, type ToolRole } from './wksp-tools'
import { enforceTool } from './chat-tool-policy'
import { ToolPages } from './tool-pages'
import { projectEngineSummary } from './engine-facts'

export interface ChatToolBinding {
  home: Home
  role: ToolRole
  /** Trusted application scope. '*' is reserved for the main base. */
  worlds: '*' | readonly string[]
  signal: AbortSignal
  hooks?: ToolHooks
}

const BOT_READS = new Set(['play_status', 'play_console', 'play_stats', 'play_frame', 'assets_find', 'asset_info', 'asset_locate', 'fleet_view', 'unit_state', 'read_task_file',
  'terminal_tail', 'quest_list', 'choice_list', 'world_list', 'world_posture', 'status_report', 'memory_read',
  'memory_report', 'mail_list', 'dispatch_profiles', 'loadout_preview', 'toolchain_check', 'ally_list', 'escalate',
  'procedure_read', 'skill_read', 'settings_read', 'event_read', 'events_ack'])
// These services aggregate across worlds or create new authority. Until they
// offer scoped APIs, limited-world connections cannot call them at all.
const GLOBAL_ONLY = new Set(['status_report', 'dispatch_profiles', 'world_add', 'world_create',
  'mail_list', 'mail_ack', 'mail_reply', 'ally_list', 'ally_route', 'report_to_main', 'presence_set', 'settings_update'])
const fail = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] })
const result = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] })

/** A capability object owned by the Electron chat lifecycle, not by the model.
 * Every request validates targets against this captured scope before invoking
 * the same handlers used by Claude. No new AppCtx or fleet is constructed.
 */
export function createChatToolSession(getCtx: () => AppCtx, binding: ChatToolBinding) {
  const { home, role, signal } = binding
  const ctx = getCtx()
  if (ctx.home(home.name).home !== home) throw new Error('Unknown chat home')
  if ((role === 'ally' && home.isMain) || (role === 'genio' && !home.isMain)) throw new Error('Role does not match chat home')
  if (binding.worlds === '*' && !home.isMain) throw new Error('Allies require an explicit project scope')
  const worlds = binding.worlds === '*' ? undefined : new Set(binding.worlds)
  if (!home.isMain) {
    const ally = ctx.allies.list().find(a => a.name === home.name && !a.retiredAt)
    if (!ally || [...worlds!].some(w => !ally.projects.includes(w))) throw new Error('Project scope exceeds ally authority')
  }
  const within = (world: unknown) => typeof world === 'string' && (!worlds || worlds.has(world))
  const withinChoice = (d: { project?: string; wksp?: string }) => within(d.project) || (!d.project && d.wksp === home.name)
  const checkWorld = (world: unknown) => { if (!within(world)) throw new Error('Project is outside this connection scope') }
  const checkTask = (id: unknown) => {
    const found = typeof id === 'string' ? findTask(getCtx(), id, home) : undefined
    if (!found) throw new Error('Task is outside this chat')
    checkWorld(found.task.project)
  }
  const checkQuest = (id: unknown) => {
    const quest = typeof id === 'string' ? [...getCtx().homes.values()].map(h => h.backlog.get(id)).find(Boolean) : undefined
    if (!quest || (worlds && !within(quest.project))) throw new Error('Quest is outside this connection scope')
  }
  const tools = createToolRegistry(getCtx, home, role, binding.hooks).filter(t =>
    (role !== 'bot' || BOT_READS.has(t.name)) && (!worlds || !GLOBAL_ONLY.has(t.name)))
  const byName = new Map(tools.map(t => [t.name, t]))
  const registered = new Set(byName.keys())
  const pages = new ToolPages()
  const descriptors = tools.map(t => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(z.strictObject(t.shape), { io: 'input' }) }))
  return {
    list() {
      if (signal.aborted) throw new Error('Chat closed')
      return descriptors
    },
    async call(name: string, input: unknown): Promise<CallToolResult> {
      const tool = byName.get(name)
      if (!tool || signal.aborted) return fail('Unknown or unavailable tool, or chat closed')
      try {
        // Strict top-level validation rejects forged role/chat/scope fields.
        const validated = z.strictObject(tool.shape).parse(input)
        const args = (tool.shape.world ? normalizeProjectArgs(validated, { world: tool.shape.world }) : validated) as Record<string, unknown>
        if (role === 'bot' && name === 'status_report' && args.file) return fail('Bot reports are read-only')
        if (args.world !== undefined) checkWorld(args.world)
        if (worlds && name === 'generate_image' && Array.isArray(args.refs) && args.refs.some(ref => typeof ref === 'string' && path.isAbsolute(ref))) {
          throw new Error('Scoped image references must be attachments in this chat')
        }
        if (args.task !== undefined) checkTask(args.task)
        if (worlds && (name === 'event_read' || name === 'events_ack')) {
          const seqs = name === 'event_read' ? [args.seq] : args.seqs as number[]
          for (const seq of seqs) {
            const event = getCtx().home(home.name).wakes.get(Number(seq))
            if (!event?.taskId) throw new Error('Event has no project-scoped task')
            checkTask(event.taskId)
          }
        }
        if (args.quest_id !== undefined) checkQuest(args.quest_id)
        if (Array.isArray(args.depends_on)) for (const id of args.depends_on) checkQuest(id)
        if (name.startsWith('quest_') && args.id !== undefined) checkQuest(args.id)
        if (name === 'choice_resolve') {
          const d = findDecision(getCtx(), String(args.id))?.d
          if (!d) throw new Error('Choice is outside this chat')
          if (d.taskId) checkTask(d.taskId)
          if (d.backlogId) checkQuest(d.backlogId)
          if (worlds && !withinChoice(d)) throw new Error('Choice is outside this project')
        }
        if (args.run !== undefined) {
          const card = agentGeneration(getCtx()).status(String(args.run), home.name)
          if (card.world) checkWorld(card.world)
          else if (worlds) throw new Error('Generation is outside this connection scope')
        }
        if (worlds && name === 'world_sync' && args.world === undefined) throw new Error('Scoped sync requires a project')
        if (worlds && name === 'quest_add' && args.world === undefined) throw new Error('Scoped quest requires a project')
        const d = await enforceTool({ role, chat: home.name, signal, permissions: getCtx().permissions,
          shellMode: () => chatControls(getCtx().settings.get(), getCtx().allies.list().find(a => a.name === home.name)).shellMode
        }, { runtime: 'bridge', name, input: args, registered })
        if (d.behavior === 'deny') return fail(d.message)
        if (signal.aborted) return fail('Chat closed')
        if (worlds && name === 'fleet_view') return pages.read(name, args, () => {
          const homes = [...getCtx().homes.values()]
          return result({
            tasks: homes.flatMap(h => h.crew.list()).filter(t => within(t.project)),
            quests: homes.flatMap(h => h.backlog.list()).filter(q => within(q.project) && !['done', 'dropped'].includes(q.state)),
            choices: homes.flatMap(h => h.decisions.list(false)).filter(withinChoice)
          })
        })
        if (worlds && name === 'world_list') return pages.read(name, args, () => result(getCtx().projects.list().filter(p => within(p.name)).map(p => ({ ...p, engineSummary: projectEngineSummary(p) }))))
        if (worlds && name === 'quest_list') return pages.read(name, args, () => result([...getCtx().homes.values()].flatMap(h => h.backlog.list()).filter(q => within(q.project) && (args.include_done || !['done', 'dropped'].includes(q.state)))))
        if (worlds && name === 'choice_list') return pages.read(name, args, () => result([...getCtx().homes.values()].flatMap(h => h.decisions.list(Boolean(args.include_resolved))).filter(withinChoice)))
        return await tool.invoke(args)
      } catch {
        // Do not reflect malformed arguments (which can contain credentials).
        return fail('Invalid arguments or target outside this connection scope')
      }
    }
  }
}
