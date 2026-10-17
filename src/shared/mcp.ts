/**
 * The player's MCP servers (docs/mcp-servers.md): one list in Settings → Advanced → Agent tools.
 * Only the player adds a server. Claude and Codex units get each server in scope through Genio's
 * gateway; secret values live only in Genio's secret store, never in this list.
 */

export interface McpServer {
  id: string
  /** Plain unique name, also the tool prefix units see (mcp__<name>__<tool>). */
  name: string
  /** A local server: the program Genio starts... */
  command?: string
  args?: string[]
  /** ...or a remote server over streamable HTTP. */
  url?: string
  /** Secret names: environment variables of a local server, headers of a remote one. Values are in the secret store. */
  secrets: string[]
  /** A project name, or absent for every project. */
  project?: string
  /** For the Claude chat only, never a unit (work tools such as mail or documents); absent means units and chat. */
  chatOnly?: boolean
  /** A remote server that answered Genio's check with OAuth sign-in and dynamic registration: it gets a Sign in action. */
  signIn?: boolean
}

/** What the renderer sees: the entry plus which secrets have a stored value, never the values. */
export interface McpServerView extends McpServer {
  secretSet: Record<string, boolean>
  /** Genio holds a sign-in for it (never the tokens themselves). */
  signedIn: boolean
}

/** A save from Settings: a secret's value replaces the stored one; an empty or absent value keeps it. */
export interface McpServerInput {
  id?: string
  name: string
  command?: string
  args?: string[]
  url?: string
  secrets: { name: string; value?: string }[]
  project?: string
  chatOnly?: boolean
}

/** Reserved: Genio's own tool server in the chat. */
export const MCP_RESERVED_NAMES = ['genio']
export const MCP_NAME_MAX = 32
export const MCP_SECRETS_MAX = 8

/** Names compare as Codex sanitises them: lower case, `-` and `_` alike. */
export const mcpNameKey = (name: string): string => name.trim().toLowerCase().replace(/_/g, '-')

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The first problem with an entry, in plain words, or undefined when it is valid. */
export function mcpServerProblem(s: McpServerInput, others: Pick<McpServer, 'id' | 'name'>[], projects: string[]): string | undefined {
  const name = s.name.trim()
  if (!name) return 'Give the server a name.'
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return 'Use lower-case letters, digits and dashes in the name, starting with a letter or digit.'
  if (name.length > MCP_NAME_MAX) return `Keep the name to ${MCP_NAME_MAX} characters.`
  if (MCP_RESERVED_NAMES.includes(name)) return `"${name}" is reserved for Genio's own tools.`
  if (others.some((o) => o.id !== s.id && mcpNameKey(o.name) === mcpNameKey(name))) return `Another server is already called "${name}".`
  const command = s.command?.trim() ?? ''
  const url = s.url?.trim() ?? ''
  if (!command === !url) return 'Give either a command or a URL.'
  if (/[\r\n\0]/.test(command) || (s.args ?? []).some((a) => /[\r\n\0]/.test(a))) return 'The command and arguments must be on one line.'
  if (url) {
    let u: URL
    try { u = new URL(url) } catch { return 'The URL is not valid.' }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) return 'Use an https:// URL (http:// only on this PC).'
    if (u.username || u.password) return 'Put credentials in a secret header, not in the URL.'
  }
  const names = s.secrets.map((x) => x.name.trim())
  if (names.length > MCP_SECRETS_MAX) return `At most ${MCP_SECRETS_MAX} secrets per server.`
  const valid = url ? /^[A-Za-z0-9-]+$/ : /^[A-Za-z_][A-Za-z0-9_]*$/
  const bad = names.find((n) => !valid.test(n))
  if (bad !== undefined) return url ? `"${bad}" is not a header name.` : `"${bad}" is not an environment variable name.`
  const seen = new Set<string>()
  for (const n of names) {
    const k = n.toLowerCase()
    if (seen.has(k)) return `"${n}" is listed twice.`
    seen.add(k)
  }
  if (s.secrets.some((x) => x.value !== undefined && /[\r\n\0]/.test(x.value))) return 'A secret value must be on one line.'
  if (s.project && !projects.includes(s.project)) return `There is no project called "${s.project}".`
  return undefined
}

/** The servers a unit or the chat in `project` gets: every project's, plus the ones scoped to it; a unit never gets a Chat only one. */
export const mcpServersFor = <T extends Pick<McpServer, 'project' | 'chatOnly'>>(list: T[], project: string, who: 'unit' | 'chat'): T[] =>
  list.filter((s) => (!s.project || s.project === project) && (who === 'chat' || !s.chatOnly))

/** Arguments as the player types them: spaces separate, double quotes keep spaces. */
export function splitArgs(text: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  let any = false
  for (const c of text) {
    if (c === '"') { quoted = !quoted; any = true } else if (!quoted && /\s/.test(c)) {
      if (any) out.push(cur)
      cur = ''
      any = false
    } else { cur += c; any = true }
  }
  if (any) out.push(cur)
  return out
}

/** The arguments back as one line, quoting those with spaces. */
export const joinArgs = (args: string[]): string => args.map((a) => (a === '' || /\s/.test(a) ? `"${a}"` : a)).join(' ')
