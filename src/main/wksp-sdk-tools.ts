/** Claude SDK adapter; tool definitions and handlers belong to the app. */
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { AppCtx } from './services'
import type { Home } from './home'
import { createChatToolSession } from './chat-tool-session'
import { createToolRegistry, type ToolHooks, type ToolRole } from './wksp-tools'

type ToolFn = typeof import('@anthropic-ai/claude-agent-sdk').tool
export function buildTools(tool: ToolFn, getCtx: () => AppCtx, home: Home, role: ToolRole, hooks: ToolHooks = {}, worlds?: readonly string[]): SdkMcpToolDefinition<any>[] {
  const scoped = worlds ? createChatToolSession(getCtx, {
    home, role: 'ally', worlds,
    signal: new AbortController().signal, hooks
  }) : undefined
  const names = scoped && new Set(scoped.list().map(t => t.name))
  return createToolRegistry(getCtx, home, role, hooks).filter(t => !names || names.has(t.name))
    .map(t => tool(t.name, t.description, t.shape, args => scoped ? scoped.call(t.name, args) : t.invoke(args)))
}
