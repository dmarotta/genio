import { CODEX_CHAT_DISABLED, type CodexRpc, type CodexWireEvents } from '../../src/main/codex-chat-driver'
export const MODEL = { model: 'gpt-test', inputModalities: ['text', 'image'], defaultReasoningEffort: 'high',
  supportedReasoningEfforts: ['low', 'high', 'ultra'].map(reasoningEffort => ({ reasoningEffort })) }

/** Deterministic app-server peer: runs the real handshake and request/event adapter. */
export class FakeAppServer implements CodexRpc {
  events!: CodexWireEvents
  sent: { method: string; params: any }[] = []
  account: any = { type: 'chatgpt' }
  features = Object.fromEntries(CODEX_CHAT_DISABLED.map(n => [n, false]))
  model = MODEL
  sandbox = { type: 'readOnly', networkAccess: false }
  turn = 0
  async request(method: string, params: any): Promise<any> {
    this.sent.push({ method, params })
    if (method === 'account/read') return { account: this.account }
    if (method === 'config/read') return { config: { features: this.features, mcp_servers: { global: {} } } }
    if (method === 'model/list') return { data: [this.model] }
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread-1' }, model: this.model.model,
      modelProvider: 'openai', sandbox: this.sandbox, approvalPolicy: 'untrusted', approvalsReviewer: 'user', reasoningEffort: 'high' }
    if (method === 'turn/start') {
      const turn = { id: `turn-${++this.turn}` }
      this.emit('turn/started', { turn }); return { turn }
    }
    return {}
  }
  notify(method: string, params: unknown): void { this.sent.push({ method, params }) }
  close(): void {}
  emit(method: string, params: any): void { this.events.notification(method, { threadId: 'thread-1', ...params }) }
  call(tool: string, callId = 'call-1', args: unknown = {}) {
    return this.events.request('item/tool/call', { threadId: 'thread-1', turnId: `turn-${this.turn}`, callId, namespace: null, tool, arguments: args })
  }
  finish(): void { this.emit('turn/completed', { turn: { id: `turn-${this.turn}`, status: 'completed' } }) }
}
