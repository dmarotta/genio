#!/usr/bin/env node
// The only MCP entry a unit gets per player server (docs/mcp-servers.md): a
// dependency-free pipe from stdio to Genio's MCP gateway in the main process.
// It holds no server secret and starts nothing; the gateway checks the
// per-launch secret, starts or calls the real server and logs every call.
// node genio-mcp-relay.mjs <server>   Env: GENIO_MCP_GATEWAY=127.0.0.1:<port>, GENIO_MCP_SECRET
// Never write diagnostics to stdout: it carries JSON-RPC only.
import net from 'node:net'

const server = process.argv[2] ?? ''
const gateway = /^127\.0\.0\.1:(\d{1,5})$/.exec(process.env.GENIO_MCP_GATEWAY ?? '')
const secret = process.env.GENIO_MCP_SECRET ?? ''
if (!gateway || !/^[a-f0-9]{64}$/.test(secret) || !/^[a-z0-9][a-z0-9-]*$/.test(server)) process.exit(1)

let connected = false
const sock = net.connect(Number(gateway[1]), '127.0.0.1', () => {
  connected = true
  sock.write(JSON.stringify({ secret, server }) + '\n')
  process.stdin.pipe(sock)
  sock.pipe(process.stdout)
})
// The relay ends with its unit: stdin closing (the agent stopped) or the gateway dropping it.
// Only a gateway that cannot be reached is a failure.
const end = (code) => () => { sock.destroy(); process.exit(code) }
sock.on('close', () => end(connected ? 0 : 1)())
sock.on('error', () => end(connected ? 0 : 1)())
process.stdin.on('end', end(0))
process.stdin.on('error', end(0))
process.stdout.on('error', end(0))
process.on('SIGTERM', end(0))
process.on('SIGINT', end(0))
