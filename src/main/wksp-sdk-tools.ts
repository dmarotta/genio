/** Claude SDK adapter; tool definitions and handlers belong to the app. */
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { AppCtx } from './services'
import type { Home } from './home'
import { createToolRegistry, type ToolHooks, type ToolRole } from './wksp-tools'

type ToolFn = typeof import('@anthropic-ai/claude-agent-sdk').tool
export function buildTools(tool: ToolFn, getCtx: () => AppCtx, home: Home, role: ToolRole, hooks: ToolHooks = {}): SdkMcpToolDefinition<any>[] {
  return createToolRegistry(getCtx, home, role, hooks).map(t => tool(t.name, t.description, t.shape, args => t.invoke(args)))
}
