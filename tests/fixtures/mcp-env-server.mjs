// A stdio MCP test server for the gateway tests: newline-delimited JSON-RPC, no dependencies.
// Tools: echo (text back), env_dump (its whole environment and cwd), fail (an isError result).
import { createInterface } from 'node:readline'

const TOOLS = [
  { name: 'echo', description: 'Echo a text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'env_dump', description: 'The server process environment and cwd.', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: 'Always fails.', inputSchema: { type: 'object', properties: {} } }
]
const text = (t, isError) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) })

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) return
  const ok = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  if (method === 'initialize') return ok({ protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'env-server', version: '1' } })
  if (method === 'tools/list') return ok({ tools: TOOLS })
  if (method === 'tools/call') {
    const name = params?.name
    if (name === 'echo') return ok(text(`ECHO: ${params.arguments?.text ?? ''}`))
    if (name === 'env_dump') return ok(text(JSON.stringify({ env: process.env, cwd: process.cwd() })))
    if (name === 'fail') return ok(text('it failed', true))
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }) + '\n')
}).on('close', () => process.exit(0))
