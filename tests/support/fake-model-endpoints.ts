/**
 * Fake model endpoints for real-CLI tests: no model, no account, no network. Each one calls the first
 * tool whose name matches `target` on its first turn, records the tool result it gets back, then ends
 * the turn. Anthropic Messages (Claude Code) and OpenAI Responses (Codex), both streamed.
 */
import http from 'node:http'

export interface FakeModel {
  url: string
  /** Tool names offered in each request. */
  requests: string[][]
  /** The text of each tool result the CLI sent back. */
  results: string[]
  close(): Promise<void>
}

async function serve(handle: (body: Record<string, unknown>, res: http.ServerResponse, fake: FakeModel) => void): Promise<FakeModel> {
  const fake: FakeModel = { url: '', requests: [], results: [], close: async () => undefined }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      if (req.method !== 'POST') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[],"has_more":false}'); return }
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(raw) } catch { /* empty */ }
      if (req.url?.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":100}'); return }
      handle(body, res, fake)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  fake.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  fake.close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) })
  return fake
}

const sse = (res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  return (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
}
const text = (c: unknown): string => typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b as { text?: string }).text ?? '').join('') : JSON.stringify(c)

export function fakeAnthropic(target: RegExp): Promise<FakeModel> {
  let n = 0
  return serve((body, res, fake) => {
    const tools = (body.tools as { name?: string }[] | undefined ?? []).map((t) => t.name ?? '')
    fake.requests.push(tools)
    const msgs = (body.messages as { content?: unknown }[] | undefined) ?? []
    const blocks = msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])) as { type: string; name?: string; content?: unknown }[]
    for (const b of blocks.filter((x) => x.type === 'tool_result')) fake.results.push(text(b.content))
    const called = blocks.some((b) => b.type === 'tool_use' && target.test(b.name ?? ''))
    const tool = tools.find((t) => target.test(t))
    // MCP tools connect in the background: a harmless built-in call buys one more request.
    const next = !called && tool ? { name: tool, input: {} } : !called && tools.includes('Glob') && blocks.filter((b) => b.type === 'tool_use').length < 4 ? { name: 'Glob', input: { pattern: 'no-such-file-*.zz' } } : undefined
    const ev = sse(res)
    const id = `msg_fake_${++n}`
    ev('message_start', { message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    if (next) {
      ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_fake_${n}`, name: next.name, input: {} } })
      ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(next.input) } })
    } else {
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'FAKE-DONE' } })
    }
    ev('content_block_stop', { index: 0 })
    ev('message_delta', { delta: { stop_reason: next ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
    ev('message_stop', {})
    res.end()
  })
}

export function fakeResponses(target: RegExp): Promise<FakeModel> {
  let n = 0
  return serve((body, res, fake) => {
    const flat = ((body.tools as { type?: string; name?: string; tools?: { name?: string }[] }[] | undefined) ?? [])
      .flatMap((t) => (t.type === 'namespace' ? (t.tools ?? []).map((x) => ({ name: x.name ?? '', ns: t.name })) : [{ name: t.name ?? '', ns: undefined }]))
    fake.requests.push(flat.map((t) => (t.ns ? `${t.ns}/${t.name}` : t.name)))
    const input = (body.input as { type?: string; output?: unknown }[] | undefined) ?? []
    const outputs = input.filter((x) => /_output$/.test(x.type ?? ''))
    for (const o of outputs) fake.results.push(text(o.output))
    const tool = flat.find((t) => target.test(t.name))
    const id = `resp_fake_${++n}`
    const item = !outputs.length && tool
      ? { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: tool.name, ...(tool.ns ? { namespace: tool.ns } : {}), arguments: '{}' }
      : { type: 'message', role: 'assistant', id: `msg_${n}`, content: [{ type: 'output_text', text: 'FAKE-DONE' }] }
    const ev = sse(res)
    ev('response.created', { response: { id } })
    ev('response.output_item.added', { output_index: 0, item })
    ev('response.output_item.done', { output_index: 0, item })
    ev('response.completed', { response: { id, usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 } } })
    res.end()
  })
}
