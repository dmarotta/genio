/**
 * The player's MCP servers in the Claude chat (docs/mcp-servers.md). The chat gets the same relays to
 * Genio's gateway as a Claude unit, as `mcpServers` entries beside Genio's own `genio` server: the
 * servers for all projects plus the ones scoped to the chat's project, Chat only ones included. The Bot and the Codex chat get
 * none (workspace.ts adds these only to the Claude chat's options). The entries carry no `alwaysLoad`, so
 * with tool search on their tools are deferred while Genio's own stay loaded. Each new chat query
 * gets a fresh per-launch secret; the previous query's is revoked.
 */
import path from 'node:path'
import type { McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { mcpServersFor } from '@shared/mcp'
import { mcpGateway, type McpGateway } from './mcp-gateway'
import { readMcpServers } from './mcp-servers'

export interface ChatMcp {
  /** The chat's base: its gateway caller is `chat:<base>`. */
  chat: string
  /** The chat's project, or '' for a chat with none (then only servers for all projects). */
  project: string
  /** The folder local servers start in: the chat's own working folder. */
  cwd: string
  /** Main base data folder: the server list and the secret store. */
  dataDir: string
  /** The chat's call log. */
  logFile: string
  /** Genio's executable, and the app folder holding the relay script it runs as Node. */
  command: string
  appRoot: string
  /** A tool call that worked; `chatOnly` when its server is set to Chat only. */
  onSuccess?(server: string, tool: string, chatOnly: boolean): void
  gateway?: McpGateway
}

export const chatMcpCaller = (chat: string): string => `chat:${chat}`

/** The chat's relay entries, keyed by server name; empty when no server is in scope. */
export async function chatMcpServers(o: ChatMcp): Promise<Record<string, McpStdioServerConfig>> {
  const gateway = o.gateway ?? mcpGateway()
  const id = chatMcpCaller(o.chat)
  gateway.revoke(id)
  const servers = mcpServersFor(readMcpServers(o.dataDir), o.project, 'chat')
  if (!servers.length) return {}
  const script = path.join(o.appRoot, 'resources', 'genio-mcp-relay.mjs')
  const onSuccess = o.onSuccess && ((name: string, tool: string): void => o.onSuccess!(name, tool, servers.some((s) => s.name === name && s.chatOnly)))
  const grant = await gateway.grant({ id, kind: 'chat', project: o.project, cwd: o.cwd, dataDir: o.dataDir, logFile: o.logFile, onSuccess }, servers)
  return Object.fromEntries(servers.map((s) => [s.name,
    { type: 'stdio' as const, command: o.command, args: [script, s.name], env: { ...grant.env, ELECTRON_RUN_AS_NODE: '1' } }]))
}
