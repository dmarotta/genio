// Stand-in for `codex exec --json` in tests: one image_gen generation per "Item n"
// in the stdin prompt, recorded in a session rollout under $CODEX_HOME the way
// Codex 0.162 lays it out. FAKE_CODEX_MODE=no-image makes none; FAKE_CODEX_USED
// sets the plan meter's used_percent.
// `archive <id>` / `unarchive <id>` move the rollout between sessions/YYYY/MM/DD
// and the flat archived_sessions/ like Codex does; a `live-<id>` marker file in
// $CODEX_HOME makes archive refuse with exit 1 (a thread still open elsewhere).
// `login` / `logout` / `login status` keep a fake-login marker in $CODEX_HOME
// (never an auth.json). `app-server` answers the metadata calls Genio makes
// (account/read, account/rateLimits/read, config/read, model/list) and logs
// the CODEX_HOME it ran in to $FAKE_CODEX_LOG.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const home = process.env.CODEX_HOME
const [command, id] = process.argv.slice(2)
const loginFile = path.join(home ?? '', 'fake-login')
if (command === '--version') {
  process.stdout.write('codex-cli 0.162.1 (fake)\n')
  process.exit(0)
}
if (command === 'login' || command === 'logout') {
  if (command === 'logout') fs.rmSync(loginFile, { force: true })
  else if (id === 'status') {
    // Codex prints its login state on stderr; exit 1 when signed out.
    const state = fs.existsSync(loginFile) ? fs.readFileSync(loginFile, 'utf8') : 'Not logged in'
    process.stderr.write(`${state}\n`)
    process.exit(fs.existsSync(loginFile) ? 0 : 1)
  } else {
    // FAKE_CODEX_LOGIN_DELAY_MS stands in for the browser round trip (screenshots).
    process.stdout.write('Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate.\n')
    const delay = Number(process.env.FAKE_CODEX_LOGIN_DELAY_MS ?? 0)
    if (delay) await new Promise((r) => setTimeout(r, delay))
    fs.writeFileSync(loginFile, 'Logged in using ChatGPT')
    process.stdout.write('Successfully logged in\n')
  }
  process.exit(0)
}
if (command === 'app-server') {
  if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ command, CODEX_HOME: home }) + '\n')
  const argv = process.argv.slice(2)
  const disabled = argv.flatMap((a, i) => (argv[i - 1] === '--disable' ? [a] : []))
  const chatgpt = fs.existsSync(loginFile) && /ChatGPT/.test(fs.readFileSync(loginFile, 'utf8'))
  const used = Number(process.env.FAKE_CODEX_USED ?? 7)
  const bucket = { limitId: 'codex', limitName: null, primary: { usedPercent: used, windowDurationMins: 10080, resetsAt: 1792480369 }, secondary: null, planType: 'pro' }
  const results = {
    initialize: {},
    'account/read': { account: chatgpt ? { type: 'chatgpt', email: 'player@example.com', planType: 'pro' } : null },
    'account/rateLimits/read': { rateLimits: bucket, rateLimitsByLimitId: { codex: bucket } },
    'config/read': { config: { features: Object.fromEntries(disabled.map((n) => [n, false])), mcp_servers: {} } },
    'model/list': { data: [{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', inputModalities: ['text'] }] }
  }
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line)
    if (m.id === undefined) return
    process.stdout.write(JSON.stringify(m.method in results ? { id: m.id, result: results[m.method] } : { id: m.id, error: { message: 'unsupported' } }) + '\n')
  })
  process.stdin.on('end', () => process.exit(0))
} else main()

// archive / unarchive, and `exec --json` (image runs)
function main() {
if (command === 'archive' || command === 'unarchive') {
  fs.appendFileSync(path.join(home, 'fake-calls.jsonl'), JSON.stringify({ command, id }) + '\n')
  const sessions = path.join(home, 'sessions')
  const archived = path.join(home, 'archived_sessions')
  const find = (dir) => {
    try {
      const rel = fs.readdirSync(dir, { recursive: true }).map(String).find((r) => r.endsWith(`-${id}.jsonl`))
      return rel ? path.join(dir, rel) : null
    } catch {
      return null
    }
  }
  const from = command === 'archive' ? find(sessions) : find(archived)
  if (!from || (command === 'archive' && fs.existsSync(path.join(home, `live-${id}`)))) {
    process.stderr.write(`Error: failed to ${command} session\n`)
    process.exit(1)
  }
  const day = path.basename(from).match(/^rollout-(\d{4})-(\d{2})-(\d{2})/)
  const dest = command === 'archive' ? archived : path.join(sessions, day[1], day[2], day[3])
  fs.mkdirSync(dest, { recursive: true })
  fs.renameSync(from, path.join(dest, path.basename(from)))
  process.stdout.write(`${command === 'archive' ? 'Archived' : 'Unarchived'} session ${id}.\n`)
  process.exit(0)
}
let prompt = ''
process.stdin.on('data', (d) => (prompt += d))
process.stdin.on('end', () => {
  const thread = crypto.randomUUID()
  fs.writeFileSync(path.join(home, 'fake-args.json'), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), prompt }))
  const n = process.env.FAKE_CODEX_MODE === 'no-image' ? 0 : (prompt.match(/^Item \d+/gm) ?? []).length
  const now = new Date()
  const pad = (x) => String(x).padStart(2, '0')
  const day = path.join(home, 'sessions', String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()))
  fs.mkdirSync(day, { recursive: true })
  const lines = [{ timestamp: now.toISOString(), type: 'session_meta', payload: { id: thread, cwd: process.cwd(), originator: 'codex_exec' } }]
  const limits = (used) => ({ limit_id: 'codex', primary: { used_percent: used, window_minutes: 10080, resets_at: 1792480369 }, secondary: null, plan_type: 'pro', rate_limit_reached_type: null })
  lines.push({ timestamp: now.toISOString(), type: 'event_msg', payload: { type: 'token_count', info: {}, rate_limits: limits(1) } })
  const promptsIn = prompt.split(/^Item \d+ \(transparent background: (?:yes|no)\):\n/m).slice(1).map((s) => s.trim())
  for (let i = 0; i < n; i++) {
    const id = `exec-${crypto.randomUUID()}`
    const saved = path.join(home, 'generated_images', thread, `${id}.png`)
    fs.mkdirSync(path.dirname(saved), { recursive: true })
    fs.writeFileSync(saved, Buffer.from(PNG1, 'base64'))
    lines.push({
      timestamp: now.toISOString(),
      type: 'event_msg',
      payload: {
        type: 'item_completed', thread_id: thread,
        item: { type: 'Extension', kind: 'image_gen.generation', id, status: 'completed', revisedPrompt: `revised: ${promptsIn[i]}`, result: PNG1, transparentBackground: /yes/.test(prompt), failure: null, savedPath: saved },
        completed_at_ms: now.getTime()
      }
    })
  }
  lines.push({ timestamp: now.toISOString(), type: 'event_msg', payload: { type: 'token_count', info: {}, rate_limits: limits(Number(process.env.FAKE_CODEX_USED ?? 5)) } })
  lines.push({ timestamp: now.toISOString(), type: 'event_msg', payload: { type: 'task_complete', duration_ms: 1000 } })
  fs.writeFileSync(path.join(day, `rollout-2026-10-13T10-50-16-${thread}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const ev = [{ type: 'thread.started', thread_id: thread }, { type: 'turn.started' }, { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'done' } }, { type: 'turn.completed' }]
  process.stdout.write(ev.map((e) => JSON.stringify(e)).join('\n') + '\n')
})
}
