/**
 * Mail (companion captain inbox, bin/fm-inbox.sh): notes the player sends from
 * elsewhere — another device, a script, a phone shortcut. Each note raises a
 * `check` event for Genio; Genio can publish a durable reply per note.
 *
 * Optional local HTTP intake (settings.inboxServer), bound to 127.0.0.1 and
 * protected by a bearer token:
 *   GET  /health            → { ok: true }
 *   POST /mail {text,from}  → 201 note
 *   GET  /mail              → notes (newest last)
 *   GET  /mail/:id          → one note incl. reply
 */
import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { InboxNote } from '@shared/types'
import { bus } from './bus'
import type { AppCtx, InboxService } from './services'
import { nowIso, readJsonl, rid, truncate, writeText } from './util'

const MAX_NOTES = 500
const MAX_BODY = 64 * 1024

export function createInboxService(getCtx: () => AppCtx): InboxService {
  let notes: InboxNote[] | undefined
  let server: http.Server | undefined
  let serverSig = ''

  const file = (): string => getCtx().main.home.inboxFile

  function load(): InboxNote[] {
    if (!notes) {
      try {
        notes = readJsonl<InboxNote>(file()).filter((n) => n && typeof n.id === 'string')
      } catch {
        notes = []
      }
    }
    return notes
  }

  function save(): void {
    const all = load()
    if (all.length > MAX_NOTES) notes = all.slice(-MAX_NOTES)
    try {
      writeText(file(), (notes ?? []).map((n) => JSON.stringify(n)).join('\n') + ((notes ?? []).length ? '\n' : ''))
    } catch {
      /* keep in memory */
    }
    bus.publish({ type: 'inbox', notes: (notes ?? []).slice() })
  }

  const svc: InboxService = {
    list() {
      return load().slice()
    },

    submit(text, from = 'player') {
      const clean = String(text ?? '').trim()
      if (!clean) throw new Error('empty mail')
      const note: InboxNote = { id: `m-${rid(3)}`, ts: nowIso(), from: String(from || 'player').slice(0, 80), text: clean.slice(0, 16_000) }
      load().push(note)
      save()
      try {
        const ctx = getCtx()
        ctx.main.wakes.enqueue({
          kind: 'check',
          reason: `mail ${note.id} from ${note.from}: ${truncate(clean.replace(/\s+/g, ' '), 140)}`,
          lines: clean.split(/\r?\n/).slice(0, 20),
          routine: false
        })
        ctx.notifier.sfx('blip')
        ctx.main.wksp.deliverWakes()
      } catch {
        /* not wired (tests) */
      }
      return note
    },

    ack(id) {
      const n = load().find((x) => x.id === id)
      if (!n || n.ackedAt) return
      n.ackedAt = nowIso()
      save()
    },

    reply(id, text) {
      const n = load().find((x) => x.id === id)
      if (!n) throw new Error(`no mail with id "${id}"`)
      n.reply = String(text ?? '').trim()
      n.repliedAt = nowIso()
      n.ackedAt = n.ackedAt ?? n.repliedAt
      save()
    },

    configure() {
      let s
      try {
        s = getCtx().settings.get()
      } catch {
        return
      }
      if (s.inboxServer && !s.inboxToken) {
        try {
          s = getCtx().settings.save({ inboxToken: rid(16) })
        } catch {
          return
        }
      }
      const sig = s.inboxServer ? `${s.inboxPort}|${s.inboxToken}` : 'off'
      if (sig === serverSig && (sig === 'off' || server)) return
      stopServer()
      serverSig = sig
      if (!s.inboxServer) return
      startServer(s.inboxPort, s.inboxToken)
    }
  }

  function stopServer(): void {
    if (server) {
      try {
        server.close()
      } catch {
        /* already closed */
      }
    }
    server = undefined
  }

  function startServer(port: number, token: string): void {
    const srv = http.createServer((req, res) => handle(req, res, token))
    srv.on('error', (err: NodeJS.ErrnoException) => {
      bus.toast('warn', 'Mail intake offline', err.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : err.message)
      server = undefined
      serverSig = ''
    })
    srv.listen(port, '127.0.0.1')
    server = srv
  }

  function authorized(req: http.IncomingMessage, token: string): boolean {
    const h = String(req.headers.authorization ?? '')
    const m = h.match(/^Bearer\s+(.+)$/i)
    if (!m) return false
    const a = Buffer.from(m[1].trim())
    const b = Buffer.from(token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  function send(res: http.ServerResponse, code: number, body: unknown): void {
    const data = JSON.stringify(body)
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(data)
  }

  function handle(req: http.IncomingMessage, res: http.ServerResponse, token: string): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, app: 'genio' })
    if (!authorized(req, token)) return send(res, 401, { error: 'unauthorized' })

    if (req.method === 'GET' && url.pathname === '/mail') return send(res, 200, load())
    const one = url.pathname.match(/^\/mail\/([\w-]+)$/)
    if (req.method === 'GET' && one) {
      const n = load().find((x) => x.id === one[1])
      return n ? send(res, 200, n) : send(res, 404, { error: 'not found' })
    }
    if (req.method === 'POST' && url.pathname === '/mail') {
      let size = 0
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > MAX_BODY) {
          send(res, 413, { error: 'too large' })
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => {
        if (res.writableEnded) return
        const raw = Buffer.concat(chunks).toString('utf8')
        let text = raw
        let from = 'remote'
        if (String(req.headers['content-type'] ?? '').includes('json')) {
          try {
            const j = JSON.parse(raw) as { text?: unknown; from?: unknown }
            text = typeof j.text === 'string' ? j.text : ''
            if (typeof j.from === 'string' && j.from.trim()) from = j.from.trim()
          } catch {
            return send(res, 400, { error: 'invalid json' })
          }
        }
        try {
          const note = svc.submit(text, from)
          send(res, 201, note)
        } catch (e) {
          send(res, 400, { error: (e as Error).message })
        }
      })
      return
    }
    send(res, 404, { error: 'not found' })
  }

  // Restart the intake whenever settings change.
  bus.onEvent((ev) => {
    if (ev.type === 'settings') {
      try {
        svc.configure()
      } catch {
        /* ignore */
      }
    }
  })

  return svc
}
