import type { Settings } from '@shared/types'
import type { ToolRole } from './workspace-tools'
import type { PermissionBroker } from './services'
import { truncate } from './util'

// ------------------------------------------------------------------ tool policy

/**
 * Native tools a design chat never gets (it reads and talks). The project chat and allies get every native
 * tool except Skill (CHAT_DISALLOWED): writes, edits and subagents follow the approval mode like any other tool.
 * Coding is still preferably delegated to units; that is the contract's preference, not a block here.
 */
const MCP_TOOL = /^mcp__/
const SUBAGENT_RE =/agent|subagent|^task$|^task(create|update|output|stop|get|list)?$|workflow|cron|schedul|worktree|delegate|spawn|dispatch|handoff|remote|sendmessage|monitor/i
export const DISALLOWED = ['Skill', 'Agent', 'Task', 'Workflow', 'CronCreate', 'CronDelete', 'EnterWorktree', 'ExitWorktree', 'RemoteTrigger', 'SendMessage', 'Monitor', 'Write', 'Edit', 'NotebookEdit', 'MultiEdit']
/** The project chat's and allies' closed native tools: Skill only, because skill_read and settings_read replace it. */
export const CHAT_DISALLOWED = ['Skill']
const ALLOWED = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'ToolSearch'])
/** A design chat's native tools: reading the project and the web for references. No shell, no edits. */
export const DESIGN_NATIVE = ['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'ToolSearch']

/**
 * The player's credentials and logins, Genio's secrets and its spend records: no chat reads, writes or prints them
 * in any approval mode, and a click on a prompt does not open them either. Spend is approved only by the player's
 * own click or a grant Genio signs, so the files that hold grants, caps and keys are closed too. Best effort over
 * the tool's input text: it names the places, it cannot follow a script that builds a path at run time.
 */
const PROTECTED: RegExp[] = [
  /(?:^|[\\/"'\s=~])\.(?:codex|claude|ssh|aws|gnupg|azure|docker|kube)(?=[\\/"'\s]|$)/i,
  /\.claude\.json\b|\bauth\.json\b|\.credentials\.json\b|\.git-credentials\b|\.npmrc\b|\.netrc\b/i,
  /(?:^|[\\/"'\s=])\.env(?:\.[\w-]+)?(?=[\\"'\s]|$)/i,
  /\bid_(?:rsa|dsa|ecdsa|ed25519)\b|\.(?:pem|ppk|p12|pfx)\b/i,
  /\bsecrets\.json\b|\bspend(?:-grants)?\.jsonl\b|\bspend-grant(?:-key)?\.json\b|\.genio[\\/]+(?:fal|uthana|sound)[\\/]|\bscratch-config\.json\b/i,
  /\b(?:FAL_KEY|UTHANA_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|GENIO_SPEND_\w+|GENIO_BRIDGE_TOKEN|GH_TOKEN|GITHUB_TOKEN)\b/i,
  /(?:^|[;&|(]\s*)(?:printenv|env|set)\s*(?:$|[;&|)])/i,
  /\b(?:get-childitem|gci|dir|ls|get-item)\s+env:|\[(?:system\.)?environment\]::getenvironmentvariables/i,
  /\b(?:codex|claude|gh|glab|npm|az|gcloud|aws)\s+(?:auth\s+)?(?:login|logout|setup-token)\b|\b(?:gh|glab)\s+auth\s+token\b/i
]

/** True when a tool's input names a credential, a login command or a spend record (see PROTECTED). */
export function touchesProtected(input: unknown): boolean {
  let text: string
  try { text = typeof input === 'string' ? input : JSON.stringify(input) ?? '' } catch { return true }
  return PROTECTED.some(re => re.test(text))
}
export const PROTECTED_MESSAGE = "Credentials, logins, Genio's secrets and spend records are closed to the chat in every approval mode."

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
  // Genio's own tools check their own inputs (run_command and write_file included); every other tool's input is checked here.
  const genio = toolName.startsWith('mcp__genio__')
  const shell = toolName === 'Bash' || toolName === 'PowerShell'
  const cmd = shell ? String((input as { command?: string } | undefined)?.command ?? '') : ''
  if (!genio && touchesProtected(shell ? cmd : input)) return { behavior: 'deny', message: PROTECTED_MESSAGE }
  if (role === 'design') return genio || DESIGN_NATIVE.includes(toolName) ? { behavior: 'allow' }
    : { behavior: 'deny', message: 'A Lore chat reads and talks: it runs no commands, edits nothing and starts no work. To build it, the player asks Genio.' }
  if (genio) return { behavior: 'allow' }
  if (ALLOWED.has(toolName)) return { behavior: 'allow' }
  if (toolName === 'Skill') return { behavior: 'deny', message: 'Use skill_read for a named bundled skill, procedure_read for Genio procedures, or settings_read/settings_update. Broad configuration skills are not loaded into chat.' }
  if (role === 'bot' && (DISALLOWED.includes(toolName) || (!MCP_TOOL.test(toolName) && SUBAGENT_RE.test(toolName)))) {
    return { behavior: 'deny', message: 'The Bot only reads while the player is away: no edits, writes or subagents.' }
  }
  if (shell) {
    if (isReadOnlyCommand(cmd)) return { behavior: 'allow' }
    // the Bot stays read-only whatever the chat's approval mode
    if (role === 'bot') return { behavior: 'deny', message: 'The Bot only runs read-only commands while the player is away.' }
    if (shellMode === 'auto-shell' || shellMode === 'all') return { behavior: 'allow' }
    return { behavior: 'ask', input: cmd, reason: 'Not on the read-only list' }
  }
  // Everything else (native writes, edits and subagents, the player's MCP tools): denied to the Bot, run in YOLO,
  // asked otherwise. Only mcp__genio__ carries Genio's authority (deploy, merge, discard, spend), and no player
  // server may be named genio.
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
  const allowed = await policy.permissions.ask({ workspace: policy.chat, tool: name, input: decision.input, reason: decision.reason })
  if (policy.signal?.aborted) return deny('Chat closed.')
  return allowed ? { behavior: 'allow' } : deny(name === 'Bash' || name === 'PowerShell'
    ? `${policy.player ?? 'The player'} declined this command.`
    : `${policy.player ?? 'The player'} declined ${name}.`)
}

/**
 * How one of Genio's own actions is cleared. 'guarded': discarding work, merging, outward-facing steps and every
 * action that once needed the player's quoted words; it asks in Ask and Auto-approve shell and runs in YOLO.
 * 'shell': a command run through Genio's tools, under the Bash rule (read-only runs, Ask asks, the others run).
 */
export type ActionGate = 'guarded' | 'shell'

export function actionAsks(mode: Settings['chatShellMode'], gate: ActionGate): boolean {
  return gate === 'shell' ? mode === 'ask' : mode !== 'all'
}

/** What cleared an action: the player's Allow once on the prompt, or the chat's approval mode (YOLO; Auto-approve shell for commands). */
export type ActionClearance = { ok: true; via: 'prompt' | 'mode' } | { ok: false; message: string }

/**
 * The approval mode decides; the permission prompt (Deny / Allow once) carries the player's answer. Tool arguments
 * and chat text never clear an action: only the broker, which the player's click resolves, does. The Bot and design
 * chats never ask (the player is away, or the chat starts no work); their tools refuse before reaching this.
 */
export async function clearAction(policy: ToolEnforcement, action: { tool: string; line: string; gate?: ActionGate }): Promise<ActionClearance> {
  if (policy.signal?.aborted) return { ok: false, message: 'Chat closed.' }
  if (policy.role === 'bot' || policy.role === 'design') return { ok: false, message: `${action.line} This waits for ${policy.player ?? 'the player'}.` }
  if (!actionAsks(policy.shellMode(), action.gate ?? 'guarded')) return { ok: true, via: 'mode' }
  const allowed = await policy.permissions.ask({ workspace: policy.chat, tool: action.tool, input: action.line })
  if (policy.signal?.aborted) return { ok: false, message: 'Chat closed.' }
  return allowed ? { ok: true, via: 'prompt' }
    : { ok: false, message: `${policy.player ?? 'The player'} denied it: ${action.line} Nothing was changed; do not retry it unless they ask again.` }
}
