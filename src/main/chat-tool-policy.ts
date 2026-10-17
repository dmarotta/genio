import type { Settings } from '@shared/types'
import type { ToolRole } from './wksp-tools'
import type { PermissionBroker } from './services'
import { truncate } from './util'

// ------------------------------------------------------------------ tool policy

/** companion subagent guard: Genio delegates to units, never to in-session subagents. */
const SUBAGENT_RE = /agent|subagent|^task$|^task(create|update|output|stop|get|list)?$|workflow|cron|schedul|worktree|delegate|spawn|dispatch|handoff|remote|sendmessage|monitor/i
export const DISALLOWED = ['Skill', 'Agent', 'Task', 'Workflow', 'CronCreate', 'CronDelete', 'EnterWorktree', 'ExitWorktree', 'RemoteTrigger', 'SendMessage', 'Monitor', 'Write', 'Edit', 'NotebookEdit', 'MultiEdit']
const ALLOWED = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'ToolSearch'])
/** A design chat's native tools: reading the project and the web for references. No shell, no edits. */
export const DESIGN_NATIVE = ['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'ToolSearch']

const READ_ONLY_SEGMENTS: RegExp[] = [
  /^git\s+(-C\s+\S+\s+)?(status|log|diff|show|branch|rev-parse|ls-files|blame|shortlog|describe|remote(\s+-v)?|tag\s+(-l|--list)|worktree\s+list|config\s+--get)\b/i,
  /^(ls|dir|cat|type|head|tail|rg|grep|wc|pwd|echo|tree|stat|file|which|where|sort|uniq|jq|du|date|whoami|cut|awk)\b/i,
  /^find\b(?!.*\s-(exec|execdir|delete|ok|fprint)\b)/i,
  /^gh\s+(pr\s+(view|list|checks|diff|status)|run\s+(view|list)|repo\s+view|issue\s+(view|list)|search\s+prs|auth\s+status)\b/i,
  /^glab\s+(mr\s+(view|list)|ci\s+(view|list|status))\b/i,
  /^cd\s+\S+$/i,
  /^(node|npm|python|py|cargo|godot|dotnet)\s+(-v|--version)$/i
]

/** True when every segment of a shell command is a known read-only command and nothing writes. */
export function isReadOnlyCommand(cmd: string): boolean {
  const c = cmd.trim()
  if (!c) return false
  if (/[`]|\$\(|<\(|>\(/.test(c)) return false
  // allow only harmless stderr redirections; any other '>' writes a file
  const scrubbed = c.replace(/2>&1|2>\s*\/dev\/null|2>\s*nul\b/gi, '')
  if (/>/.test(scrubbed)) return false
  const segments = scrubbed.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean)
  return segments.every((s) => READ_ONLY_SEGMENTS.some((re) => re.test(s.trim())))
}

/** Waits, plain variable assignments and PowerShell reads: harmless to cut short, though never auto-approved for that. */
const INTERRUPTIBLE_SEGMENTS: RegExp[] = [
  /^(start-sleep|sleep)(\s+-(s|seconds|m|milliseconds))?\s+\d+(\.\d+)?[smhd]?$/i,
  /^\$\w+\s*=\s*('[^']*'|"[^"$]*"|\d+)$/,
  /^(get-childitem|gci|get-content|gc|get-item|get-itemproperty|test-path|resolve-path|split-path|join-path|select-object|select-string|sort-object|measure-object|format-table|format-list|out-string|get-date|get-process|convertfrom-json)\b/i
]

/**
 * True when a running tool call can be cut short by a steering interrupt with nothing left half done: a read
 * tool, or a shell command that only reads or waits (Genio's `Start-Sleep 75; Get-ChildItem …` polls).
 * Anything else (deploys, merges, quests, writes) runs to its result first.
 */
export function interruptibleTool(name: string, input: unknown): boolean {
  if (ALLOWED.has(name)) return true
  if (name !== 'Bash' && name !== 'PowerShell') return false
  const cmd = String((input as { command?: string } | undefined)?.command ?? '').trim()
  // a script block can run anything; a write, substitution or redirection is never cut
  if (!cmd || /[{}`]|\$\(|<\(|>\(/.test(cmd)) return false
  if (isReadOnlyCommand(cmd)) return true
  const scrubbed = cmd.replace(/2>&1|2>\s*\/dev\/null|2>\s*nul\b/gi, '')
  if (/>/.test(scrubbed)) return false
  return scrubbed.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean)
    .every((s) => [...READ_ONLY_SEGMENTS, ...INTERRUPTIBLE_SEGMENTS].some((re) => re.test(s.trim())))
}

export type ToolDecision ={ behavior: 'allow' } | { behavior: 'deny'; message: string } | { behavior: 'ask'; input: string; reason?: string }

/** Pure tool policy for a Genio/Bot session; 'ask' goes to the player's permission prompt. */
export function decideTool(role: ToolRole, toolName: string, input: unknown, shellMode: Settings['chatShellMode']): ToolDecision {
  // Whatever the chat's approval mode: its Genio tools are already the design list, everything else is closed.
  if (role === 'design') return toolName.startsWith('mcp__genio__') || DESIGN_NATIVE.includes(toolName) ? { behavior: 'allow' }
    : { behavior: 'deny', message: 'A design chat reads and talks: it runs no commands, edits nothing and starts no work. To build it, the player asks Genio.' }
  if (toolName.startsWith('mcp__genio__')) return { behavior: 'allow' }
  if (ALLOWED.has(toolName)) return { behavior: 'allow' }
  if (toolName === 'Skill') return { behavior: 'deny', message: 'Use skill_read for a named bundled skill, procedure_read for Genio procedures, or settings_read/settings_update. Broad configuration skills are not loaded into chat.' }
  if (DISALLOWED.includes(toolName) || SUBAGENT_RE.test(toolName)) {
    return { behavior: 'deny', message: 'Genio delegates work to units (deploy) and never writes projects or spawns in-session subagents.' }
  }
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const cmd = String((input as { command?: string } | undefined)?.command ?? '')
    if (isReadOnlyCommand(cmd)) return { behavior: 'allow' }
    // the Bot stays read-only whatever the chat's approval mode
    if (role === 'bot') return { behavior: 'deny', message: 'The Bot only runs read-only commands while the player is away.' }
    if (shellMode === 'auto-shell' || shellMode === 'all') return { behavior: 'allow' }
    return { behavior: 'ask', input: cmd, reason: 'Not on the read-only list' }
  }
  if (role === 'bot') return { behavior: 'deny', message: 'Not available to the Bot.' }
  if (shellMode === 'all') return { behavior: 'allow' }
  return { behavior: 'ask', input: truncate(JSON.stringify(input), 1500) }
}

export interface ToolEnforcement {
  role: ToolRole
  chat: string
  shellMode(): Settings['chatShellMode']
  permissions: PermissionBroker
  player?: string
  signal?: AbortSignal
}

/** Identity is supplied by the adapter, never by a tool's model-authored arguments.
 * Non-Claude native tools are closed until a driver installs a verified interceptor.
 * The bridge can invoke only registered Genio tools, never this native-tool surface.
 */
export type RuntimeTool =
  | { runtime: 'claude'; name: string; input: unknown }
  | { runtime: 'bridge'; name: string; input: unknown; registered: ReadonlySet<string> }
  | { runtime: 'codex' | 'gemini' | 'opencode'; name: string; input: unknown }

export async function enforceTool(policy: ToolEnforcement, tool: RuntimeTool): Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string }> {
  const deny = (message: string) => ({ behavior: 'deny' as const, message })
  if (policy.signal?.aborted) return deny('Chat closed.')
  let name = tool.name
  if (tool.runtime === 'bridge') {
    if (!tool.registered.has(name)) return deny('Unknown or unavailable Genio tool.')
    name = `mcp__genio__${name}`
  } else if (tool.runtime !== 'claude') {
    // Fail closed even in YOLO: native shell, edit, agent and plugin aliases must
    // never turn into Genio authority by spelling their name like an MCP tool.
    return deny('Native tools are disabled for this runtime; use the guarded Genio bridge.')
  }
  const decision = decideTool(policy.role, name, tool.input, policy.shellMode())
  if (decision.behavior !== 'ask') return decision
  const allowed = await policy.permissions.ask({ wksp: policy.chat, tool: name, input: decision.input, reason: decision.reason })
  if (policy.signal?.aborted) return deny('Chat closed.')
  return allowed ? { behavior: 'allow' } : deny(name === 'Bash' || name === 'PowerShell'
    ? `${policy.player ?? 'The player'} declined this command.`
    : `${policy.player ?? 'The player'} declined ${name}.`)
}
