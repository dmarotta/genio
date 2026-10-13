import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import type { PlayInput } from '@shared/play'

export const MAX_FRAME = 4 * 1024 * 1024
/** One authenticated Unity client; bounded latest-frame storage, never a frame queue. */
export class PlayStream {
  private server = http.createServer((_req, res) => { res.writeHead(404); res.end() })
  private ws = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false })
  private client?: WebSocket
  private token = randomBytes(32).toString('hex')
  private port = 0
  private lastInput = 0
  private lastFrame = 0
  private closed = false
  latest?: Buffer
  onFrame?: (frame: Buffer) => void
  onDisconnect?: () => void
  get connected(): boolean { return this.client?.readyState === WebSocket.OPEN }
  async listen(): Promise<{ port: number; token: string }> {
    this.server.on('upgrade', (req, socket, head) => {
      const auth = Buffer.from(req.headers.authorization ?? '')
      const expected = Buffer.from(`Bearer ${this.token}`)
      if (this.closed || req.headers.origin !== undefined || req.headers.host !== `127.0.0.1:${this.port}` || req.url !== '/play' || this.client || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return
      }
      this.ws.handleUpgrade(req, socket, head, client => {
        this.client = client
        client.on('error', () => client.terminate())
        client.on('message', (data, binary) => {
          const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
          if (!binary || frame.length < 4 || frame.length > MAX_FRAME || frame[0] !== 255 || frame[1] !== 216 || frame.at(-2) !== 255 || frame.at(-1) !== 217) { client.close(1003); return }
          const now = Date.now()
          if (now - this.lastFrame < 25) return
          this.lastFrame = now; this.latest = frame; this.onFrame?.(frame)
        })
        client.once('close', () => { if (this.client === client) { this.client = undefined; this.latest = undefined; this.onDisconnect?.() } })
      })
    })
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve) })
    this.port = (this.server.address() as { port: number }).port
    return { port: this.port, token: this.token }
  }
  input(input: PlayInput): void {
    validateInput(input)
    if (!this.connected) throw new Error('Unity stream is disconnected')
    const now = Date.now()
    // Continuous state supersedes the preceding packet; release must always get through.
    if (input.type !== 'release' && now - this.lastInput < 8) return
    if (this.client!.bufferedAmount > 65536) { this.client!.terminate(); throw new Error('Unity input stalled') }
    this.lastInput = now
    this.client!.send(JSON.stringify(input))
  }
  close(): void {
    this.closed = true; this.onFrame = undefined; this.latest = undefined
    this.client?.terminate(); this.ws.close(); this.server.close()
  }
}

export function validateInput(input: PlayInput): void {
  if (!input || !['state', 'release'].includes(input.type)) throw new Error('Invalid stream input')
  if (input.type === 'release') return
  if (!Array.isArray(input.keys) || input.keys.length > 32 || input.keys.some(k => typeof k !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,24}$/.test(k)) ||
    ![input.x, input.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1) || !Number.isInteger(input.buttons) || input.buttons < 0 || input.buttons > 7 ||
    !Array.isArray(input.axes) || input.axes.length !== 6 || input.axes.some(n => !Number.isFinite(n) || n < -1 || n > 1) ||
    !Number.isInteger(input.gamepadButtons) || input.gamepadButtons < 0 || input.gamepadButtons > 65535) throw new Error('Invalid stream input state')
}
