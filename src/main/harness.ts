/**
 * Harness adapters: how each unit CLI is launched, interrupted, recalled and
 * resumed (launch templates per harness).
 *
 * Arg templates support tokens:
 *   {model} {effort} {prompt} {cwd} {settings} {sessionId}   simple substitution
 *   {permission}                                expands to claude permission args
 * A paired element is written as one string, `--model {model}`: it splits at
 * the first space into flag + value when filled and vanishes when empty.
 * A standalone token arg (`{prompt}`) that resolves empty is dropped alone.
 * modelArgs / effortArgs / resumeArgs are inserted before the first arg that
 * carries {prompt} (or at the end). resumeArgs that start with a bare word
 * (a subcommand such as codex `resume <session-id>`) go first.
 */
import type { HarnessAdapter, Settings } from '@shared/types'

const ESC = '\x1b'
const CTRL_C = '\x03'

function adapter(a: Partial<HarnessAdapter> & Pick<HarnessAdapter, 'id' | 'name' | 'command'>): HarnessAdapter {
  return {
    args: ['{prompt}'],
    promptDelivery: 'arg',
    interrupt: ESC,
    exitSequence: '/exit',
    trustPatterns: [],
    trustResponse: '\r',
    submitKey: '\r',
    verified: true,
    role: 'any',
    models: [],
    builtin: true,
    enabled: true,
    ...a
  }
}

export const BUILTIN_HARNESSES: HarnessAdapter[] = [
  adapter({
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    args: ['{permission}', '--settings {settings}', '{prompt}'],
    modelArgs: ['--model {model}'],
    effortArgs: ['--effort {effort}'],
    resumeArgs: ['--continue'],
    env: { CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false', CLAUDE_CODE_SEND_FEEDBACK: '0' },
    exitSequence: '/exit',
    trustPatterns: ['Do you trust the files', 'trust this folder', 'Yes, I trust', 'one you trust'],
    models: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
  }),
  adapter({
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    args: ['--dangerously-bypass-approvals-and-sandbox', '{prompt}'],
    modelArgs: ['--model {model}'],
    effortArgs: ['-c model_reasoning_effort="{effort}"'],
    resumeArgs: ['resume', '{sessionId}'],
    exitSequence: '/quit',
    trustPatterns: ['Do you trust the contents of this directory'],
    role: 'any'
  }),
  adapter({
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    args: ['-y', '{prompt}'],
    modelArgs: ['-m {model}'],
    env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
    exitSequence: '/quit',
    role: 'worker'
  }),
  adapter({
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    args: ['--prompt {prompt}'],
    modelArgs: ['--model {model}'],
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { '*': 'allow' } }) },
    interrupt: ESC + ESC,
    exitSequence: '/exit'
  }),
  adapter({
    id: 'cursor',
    name: 'Cursor Agent',
    command: 'cursor-agent',
    args: ['--trust', '--yolo', '--workspace {cwd}', '{prompt}'],
    modelArgs: ['--model {model}'],
    exitSequence: '/exit'
  }),
  adapter({
    id: 'grok',
    name: 'Grok CLI',
    command: 'grok',
    args: ['--always-approve', '{prompt}'],
    modelArgs: ['--model {model}'],
    effortArgs: ['--reasoning-effort {effort}'],
    interrupt: CTRL_C,
    exitSequence: '/exit'
  }),
  adapter({
    id: 'aider',
    name: 'Aider',
    command: 'aider',
    args: ['--yes-always'],
    modelArgs: ['--model {model}'],
    promptDelivery: 'type',
    interrupt: CTRL_C,
    exitSequence: '/exit',
    role: 'worker'
  }),
  adapter({
    id: 'custom',
    name: 'Custom CLI',
    command: 'my-agent',
    args: ['{prompt}'],
    verified: false,
    enabled: false,
    role: 'worker'
  })
]

/** Claude's bypass-permissions acceptance dialog. Never answered with keys. */
/** Matches both raw and whitespace-squashed terminal text. */
export const CLAUDE_BYPASS_DIALOG = /bypass\s*permissions\s*mode|yes,?\s*i\s*accept/i

/** A TUI's working line once it took a submitted prompt (Codex: "Working (0s • esc to interrupt)"), on whitespace-squashed lower-case text. */
export const TUI_WORKING = /esc(ape)?tointerrupt/

/**
 * Claude's "We recommend compacting earlier" offer at a turn end ("Keep auto
 * (1m tokens)" / "Autocompact at ‹ 400k › tokens"), on whitespace-squashed
 * lower-case text. Returns the key that keeps the automatic window: Enter on
 * a preselected "Keep auto", else Esc ("not now", which changes no setting).
 * Undefined when the offer is not showing.
 */
export function autocompactOfferKey(squashed: string): string | undefined {
  if (!squashed.includes('autocompactat') || !/keepauto\(\d/.test(squashed)) return undefined
  const pointed = (option: string): number => Math.max(squashed.lastIndexOf(`❯${option}`), squashed.lastIndexOf(`>${option}`))
  return pointed('keepauto(') > pointed('autocompactat') ? '\r' : '\x1b'
}

/**
 * Codex's first-run folder dialog (codex-cli 0.162: "Folder access" … "Note:
 * You're in a subdirectory of a Git project. Trusting will apply to the
 * repository root: f:\…" … "Trust this folder?" … "› 1. Trust and continue
 * 2. Quit"), on whitespace-squashed lower-case text. Returns the folder it asks
 * about (squashed, as shown: the repository root when it names one) and whether
 * the pointer is on "Trust and continue". Undefined until the options are drawn.
 */
export function codexTrustDialog(squashed: string): { folder: string; onTrust: boolean } | undefined {
  const at = squashed.lastIndexOf('folderaccess')
  const ask = at < 0 ? -1 : squashed.indexOf('trustthisfolder?', at)
  const option = ask < 0 ? -1 : squashed.indexOf('1.trustandcontinue', ask)
  if (option < 0) return undefined
  const shown = squashed.slice(at + 'folderaccess'.length, ask)
  const root = shown.lastIndexOf('repositoryroot:')
  const folder = (root < 0 ? shown : shown.slice(root + 'repositoryroot:'.length)).replace(/^[:│|]+|[.│|]+$/g, '')
  const pointed = (o: string): number => Math.max(...['›', '>', '❯'].map(p => squashed.lastIndexOf(`${p}${o}`)))
  return { folder, onTrust: pointed('1.trustandcontinue') >= Math.max(pointed('2.'), pointed('3.')) }
}

export interface LaunchVars {
  model?: string
  effort?: string
  prompt?: string
  cwd?: string
  settings?: string
  resume?: boolean
  sessionId?: string
  /** Genio's own flags for this launch (unit-mcp.ts): after a resume subcommand, before the template. */
  launchArgs?: string[]
}

function permissionArgs(mode: Settings['claudePermissionMode']): string[] {
  if (mode === 'auto') return ['--permission-mode', 'auto']
  if (mode === 'acceptEdits') return ['--permission-mode', 'acceptEdits']
  return ['--dangerously-skip-permissions']
}

function substitute(arg: string, vars: LaunchVars): { value: string; hadToken: boolean; empty: boolean } {
  let hadToken = false
  let anyFilled = false
  const value = arg.replace(/\{(model|effort|prompt|cwd|settings|sessionId)\}/g, (_m, k: keyof LaunchVars) => {
    hadToken = true
    const v = vars[k]
    if (typeof v === 'string' && v) {
      anyFilled = true
      return v
    }
    return ''
  })
  return { value, hadToken, empty: hadToken && !anyFilled }
}

/** Expand a template; returns argv plus the index where a {prompt} element starts. */
function expand(template: string[], vars: LaunchVars, perm: string[]): { argv: string[]; promptAt: number } {
  const out: string[] = []
  let promptAt = -1
  for (const el of template) {
    if (el === '{permission}') {
      out.push(...perm)
      continue
    }
    const sp = el.indexOf(' ')
    const paired = el.startsWith('-') && sp > 0 && /\{\w+\}/.test(el.slice(sp + 1))
    const flag = paired ? el.slice(0, sp) : ''
    const s = substitute(paired ? el.slice(sp + 1) : el, vars)
    if (s.empty) continue
    if (el.includes('{prompt}') && promptAt < 0) promptAt = out.length
    if (paired) out.push(flag)
    out.push(s.value)
  }
  return { argv: out, promptAt }
}

/** Build the argv (without the executable) for launching a unit. */
export function buildArgs(a: HarnessAdapter, vars: LaunchVars, settings: Pick<Settings, 'claudePermissionMode'>): string[] {
  const perm = permissionArgs(settings.claudePermissionMode)
  const v: LaunchVars = { ...vars, prompt: a.promptDelivery === 'arg' ? vars.prompt : undefined }
  const { argv: main, promptAt } = expand(a.args, v, perm)
  const extras = [
    ...(vars.model && a.modelArgs ? expand(a.modelArgs, v, perm).argv : []),
    ...(vars.effort && a.effortArgs ? expand(a.effortArgs, v, perm).argv : [])
  ]
  let resumeFront: string[] = []
  if (vars.resume && a.id === 'codex') {
    // Persisted adapters can still contain --last. Never let Codex pick a
    // conversation globally (or open its interactive session picker).
    if (vars.sessionId) resumeFront = ['resume', vars.sessionId]
  } else if (vars.resume && a.resumeArgs?.length) {
    const r = expand(a.resumeArgs, v, perm).argv
    if (r[0] && !r[0].startsWith('-')) resumeFront = r
    else extras.push(...r)
  }
  const at = promptAt < 0 ? main.length : promptAt
  return [...resumeFront, ...(vars.launchArgs ?? []), ...main.slice(0, at), ...extras, ...main.slice(at)]
}

/** Merge persisted adapters with the builtins: new builtins appear, user edits persist. */
export function mergeHarnesses(saved: HarnessAdapter[] | undefined): HarnessAdapter[] {
  const byId = new Map<string, HarnessAdapter>()
  for (const b of BUILTIN_HARNESSES) byId.set(b.id, { ...b })
  for (const s of saved ?? []) {
    const base = byId.get(s.id)
    byId.set(s.id, base ? { ...base, ...s, builtin: true } : { ...s, builtin: false })
  }
  return [...byId.values()]
}
