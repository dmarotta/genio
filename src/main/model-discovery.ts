import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import type { RawModel } from '@shared/model-catalogue'
import { killTree, run, runShell, stripAnsi, which } from './util'
import { CODEX_CHAT_DISABLED } from './codex-chat-driver'
import { claudeEnv } from './claude-home'
import { codexEnv } from './codex-home'

const queries = new Set<Query>()
let claudeMetadata: RawModel[] = []
export function supportedClaudeEfforts(model?: string): string[] | undefined {
  const row = claudeMetadata.find(m => m.value === (model || 'default') || !!model && m.resolvedModel === model)
  return row ? row.supportedEffortLevels || [] : undefined
}
async function readClaudeModels(q: Query): Promise<RawModel[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const rows = await Promise.race([q.supportedModels(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Claude discovery timed out')), 25_000)
    })])
    claudeMetadata = rows
    return rows
  } finally { clearTimeout(timer) }
}
export function registerModelQuery(q: Query): () => void {
  queries.add(q)
  return () => { queries.delete(q) }
}
export async function claudeModels(executable?: string): Promise<RawModel[]> {
  const live = [...queries].at(-1)
  if (live) return readClaudeModels(live)
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  async function* input(): AsyncGenerator<never> { await hold }
  const env = { ...process.env, ...(await claudeEnv()) }
  const q = query({ prompt: input(), options: { settingSources: [], tools: [], mcpServers: {}, persistSession: false, env,
    ...(executable ? { pathToClaudeCodeExecutable: executable } : {}) } })
  const timer = setTimeout(() => { q.close(); release() }, 25_000)
  try { return await readClaudeModels(q) } finally { clearTimeout(timer); q.close(); release() }
}

/** Metadata-only JSON RPC client: never sends a prompt and refuses server tool requests. */
async function rpcModels(tool: 'codex' | 'gemini'): Promise<RawModel[]> {
  const file = await which(tool)
  if (!file) throw new Error('CLI is not installed')
  const args = tool === 'codex' ? ['app-server', '--listen', 'stdio://', ...CODEX_CHAT_DISABLED.flatMap(name => ['--disable', name])] : ['--acp']
  const shim = /\.(cmd|bat)$/i.test(file)
  // Codex reads its catalogue in Genio's own home when signed in.
  const env: NodeJS.ProcessEnv = { ...process.env, NO_BROWSER: 'true', NO_COLOR: '1', ...(tool === 'codex' ? await codexEnv() : {}) }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(shim ? 'cmd.exe' : file, shim ? ['/d', '/s', '/c', `"${file}" ${args.join(' ')}`] : args,
    { windowsHide: true, windowsVerbatimArguments: shim, detached: process.platform !== 'win32', env })
  const lines = createInterface({ input: child.stdout })
  let sequence = 0
  const waiting = new Map<number, { resolve: (value: any) => void; reject: (e: Error) => void }>()
  const fail = (message: string): void => { for (const p of waiting.values()) p.reject(new Error(message)); waiting.clear() }
  child.stderr.resume()
  child.stdin.on('error', () => fail('Discovery connection closed'))
  child.on('error', () => fail('Could not start discovery'))
  child.on('exit', () => fail('Discovery process exited'))
  const send = (message: unknown): void => { child.stdin.write(JSON.stringify(message) + '\n') }
  lines.on('line', line => {
    let m: any
    try { m = JSON.parse(line) } catch { return }
    if (m.method && m.id !== undefined) {
      send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Catalogue client: no tools' } }); return
    }
    const p = waiting.get(m.id)
    if (!p) return
    waiting.delete(m.id)
    if (m.error) p.reject(new Error(String(m.error.message || 'Discovery failed')))
    else p.resolve(m.result)
  })
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = ++sequence
    waiting.set(id, { resolve, reject }); send({ jsonrpc: '2.0', id, method, params })
  })
  const timer = setTimeout(() => { fail('Discovery timed out'); killTree(child.pid) }, 30_000)
  try {
    await request('initialize', tool === 'codex' ? { clientInfo: { name: 'genio_catalogue', version: '1.0' } } :
      { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'genio', version: '1.0' } })
    if (tool === 'gemini') {
      const result = await request('session/new', { cwd: process.cwd(), mcpServers: [] })
      return result.models?.availableModels || []
    }
    send({ method: 'initialized', params: {} })
    const account = await request('account/read', { refreshToken: true })
    if (!['chatgpt', 'chatgptAuthTokens'].includes(account.account?.type)) throw new Error('Codex ChatGPT authentication required')
    const config = (await request('config/read', { includeLayers: false })).config
    if (CODEX_CHAT_DISABLED.some(name => config?.features?.[name] !== false) || config?.model_providers?.openai ||
      Object.keys(config?.mcp_servers ?? {}).some(name => !/^[\w-]+$/.test(name))) {
      throw new Error('Codex chat tool confinement could not be validated')
    }
    const rows: RawModel[] = []
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const page = await request('model/list', { includeHidden: true, limit: 100, ...(cursor ? { cursor } : {}) })
      rows.push(...page.data)
      cursor = page.nextCursor || undefined
      if (cursor && seen.has(cursor)) throw new Error('Repeated catalogue cursor')
      if (cursor) seen.add(cursor)
    } while (cursor)
    return rows
  } finally { clearTimeout(timer); lines.close(); child.stdin.end(); killTree(child.pid) }
}
export const codexModels = (): Promise<RawModel[]> => rpcModels('codex')
export const geminiModels = (): Promise<RawModel[]> => rpcModels('gemini')
/** OpenCode verbose output is a model id followed by a pretty-printed JSON object. */
export function parseOpenCodeModels(output: string, provider: string): RawModel[] {
  const blocks = stripAnsi(output).split(new RegExp(`^${provider}/([^\\s]+)\\s*$`, 'm'))
  const rows: RawModel[] = []
  for (let i = 1; i < blocks.length; i += 2) {
    const data = blocks[i + 1].trim()
    const model = JSON.parse(data)
    // The anonymous route only advertises evidence-backed zero-cost candidates.
    if (provider === 'opencode' && (model.cost?.input !== 0 || model.cost?.output !== 0)) continue
    if (!model.capabilities?.input?.text || !model.capabilities?.output?.text) continue
    rows.push({ id: `${provider}/${blocks[i]}`, name: model.name,
      inputModalities: model.capabilities.input.image ? ['text', 'image'] : ['text'],
      hidden: model.status === 'deprecated', supportedEffortLevels: Object.keys(model.variants || {}) })
  }
  return rows
}
export async function opencodeModels(provider: string, key?: string, refresh = false): Promise<RawModel[]> {
  const file = await which('opencode')
  if (!file) throw new Error('CLI is not installed')
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', ...(key ? { OPENROUTER_API_KEY: key } : {}) }
  delete env.ELECTRON_RUN_AS_NODE
  const args = ['models', provider, '--verbose', ...(refresh ? ['--refresh'] : [])]
  const result = /\.(cmd|bat)$/i.test(file) ? await runShell(`"${file}" ${args.join(' ')}`, { env, timeoutMs: 25_000 }) :
    await run(file, args, { env, timeoutMs: 25_000 })
  if (result.code) throw new Error('OpenCode catalogue request failed')
  return parseOpenCodeModels(result.stdout, provider)
}
