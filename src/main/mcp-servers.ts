/**
 * The player's MCP server list (docs/mcp-servers.md), kept in the main base's
 * data/mcp-servers.json: names, commands, URLs, secret names and scope only.
 * Secret values go to the secret store (secrets.ts) and are never written here,
 * into a project, a brief, a log or the status file. Only Settings writes this
 * list: no chat tool, unit or repository can add a server.
 */
import path from 'node:path'
import { mcpServerProblem, type McpServer, type McpServerInput, type McpServerView } from '@shared/mcp'
import { clearMcpSecrets, mcpSecretsSet, setMcpSecret } from './secrets'
import { readJson, rid, writeJson } from './util'

const fileIn = (dataDir: string): string => path.join(dataDir, 'mcp-servers.json')

/** The stored list, minus any entry that no longer validates (a hand edit): Genio never passes those on. */
export function readMcpServers(dataDir: string): McpServer[] {
  const raw = readJson<unknown>(fileIn(dataDir), [])
  if (!Array.isArray(raw)) return []
  const out: McpServer[] = []
  for (const r of raw as McpServer[]) {
    if (!r || typeof r.id !== 'string' || !/^[\w-]+$/.test(r.id) || typeof r.name !== 'string') continue
    const s: McpServer = {
      id: r.id, name: r.name,
      ...(typeof r.command === 'string' ? { command: r.command, args: Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === 'string') : [] } : {}),
      ...(typeof r.url === 'string' ? { url: r.url } : {}),
      secrets: Array.isArray(r.secrets) ? r.secrets.filter((n): n is string => typeof n === 'string') : [],
      ...(typeof r.project === 'string' && r.project ? { project: r.project } : {})
    }
    if (!mcpServerProblem({ ...s, secrets: s.secrets.map((name) => ({ name })) }, out, s.project ? [s.project] : [])) out.push(s)
  }
  return out
}

export function mcpServerViews(dataDir: string): McpServerView[] {
  return readMcpServers(dataDir).map((s) => ({ ...s, secretSet: mcpSecretsSet(s.id, s.secrets, dataDir) }))
}

/** Add or edit one entry. Throws the plain problem when it is not valid; secrets it no longer names are deleted. */
export function saveMcpServer(input: McpServerInput, dataDir: string, projects: string[]): McpServerView[] {
  const list = readMcpServers(dataDir)
  const prev = input.id ? list.find((s) => s.id === input.id) : undefined
  if (input.id && !prev) throw new Error('That server is no longer in the list.')
  const problem = mcpServerProblem(input, list, projects)
  if (problem) throw new Error(problem)
  const id = prev?.id ?? rid(8)
  const command = input.command?.trim()
  const entry: McpServer = {
    id,
    name: input.name.trim(),
    ...(command ? { command, args: [...(input.args ?? [])] } : { url: input.url!.trim() }),
    secrets: input.secrets.map((x) => x.name.trim()),
    ...(input.project ? { project: input.project } : {})
  }
  // A value cannot follow a renamed secret or a switch between header and variable: it is asked for again.
  const kept = prev && Boolean(prev.url) === Boolean(entry.url) ? entry.secrets.filter((n) => prev.secrets.includes(n)) : []
  for (const x of input.secrets) if (x.value?.trim()) setMcpSecret(id, x.name.trim(), x.value, dataDir)
  clearMcpSecrets(id, [...kept, ...input.secrets.filter((x) => x.value?.trim()).map((x) => x.name.trim())], dataDir)
  writeJson(fileIn(dataDir), prev ? list.map((s) => (s.id === id ? entry : s)) : [...list, entry])
  return mcpServerViews(dataDir)
}

export function removeMcpServer(id: string, dataDir: string): McpServerView[] {
  const list = readMcpServers(dataDir)
  if (list.some((s) => s.id === id)) {
    writeJson(fileIn(dataDir), list.filter((s) => s.id !== id))
    clearMcpSecrets(id, [], dataDir)
  }
  return mcpServerViews(dataDir)
}
