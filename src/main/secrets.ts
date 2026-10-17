/**
 * API keys for services that have no CLI login (FAL.ai, OpenRouter, Uthana). The one deliberate
 * exception to "Genio keeps no credentials": each key is encrypted with
 * Electron safeStorage (OS-backed: DPAPI / Keychain / libsecret) and kept in
 * the main base's data/secrets.json, never in a world or in settings.json.
 * Keys are never logged or returned to the renderer; only "set" and the last
 * four characters are. The secrets of the player's MCP servers live here too,
 * keyed per server, and only ever reach that server (mcp-gateway.ts), as does
 * each server's Genio sign-in (mcp-signin.ts: its client registration and tokens).
 */
import path from 'node:path'
import { safeStorage } from 'electron'
import type { ApiKeyStatus } from '@shared/api'
import { defaultHomeRoot } from './home'
import { nowIso, readJson, writeJson } from './util'

export const SECRET_SERVICES = [
  { id: 'fal', label: 'FAL.ai', purpose: 'Generative media API (images, audio, video)' },
  { id: 'openrouter', label: 'OpenRouter', purpose: 'Cheap third-party coding models for OpenCode units, only in projects that allow them' },
  { id: 'uthana', label: 'Uthana', purpose: '3D character animation API for the Animation screen (text/video to motion, rigging, retargeting)' }
] as const
export type SecretId = (typeof SECRET_SERVICES)[number]['id']

interface SecretRecord {
  /** base64 of safeStorage.encryptString(key) */
  enc: string
  last4?: string
  setAt: string
}

/** Service keys by id, and MCP server secrets under `mcp:<server id>:<name>`. */
type SecretFile = Record<string, SecretRecord | undefined>

const defaultDir = (): string => path.join(defaultHomeRoot(), 'data')
const fileIn = (dataDir: string): string => path.join(dataDir, 'secrets.json')

function assertId(id: string): asserts id is SecretId {
  if (!SECRET_SERVICES.some((s) => s.id === id)) throw new Error(`Unknown API key service: ${id}`)
}

const mcpKey = (server: string, name: string): string => {
  if (!/^[\w-]+$/.test(server) || !/^[\w-]+$/.test(name)) throw new Error('Unknown MCP server secret.')
  return `mcp:${server}:${name}`
}

function decrypt(rec: SecretRecord | undefined): string | undefined {
  if (!rec?.enc || !safeStorage.isEncryptionAvailable()) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(rec.enc, 'base64'))
  } catch {
    return undefined
  }
}

function assertEncryption(): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is not available, so the key was not saved.')
  // Linux without a keyring falls back to a hard-coded password: not real protection.
  if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    throw new Error('No OS keyring is available (basic_text backend), so the key was not saved.')
  }
}

export function setSecret(id: string, value: string, dataDir = defaultDir()): void {
  assertId(id)
  const key = value.trim()
  if (!key) throw new Error('The key is empty.')
  assertEncryption()
  const all = readJson<SecretFile>(fileIn(dataDir), {})
  all[id] = {
    enc: safeStorage.encryptString(key).toString('base64'),
    last4: key.length >= 12 ? key.slice(-4) : undefined,
    setAt: nowIso()
  }
  writeJson(fileIn(dataDir), all)
}

export function clearSecret(id: string, dataDir = defaultDir()): void {
  assertId(id)
  const all = readJson<SecretFile>(fileIn(dataDir), {})
  if (!(id in all)) return
  delete all[id]
  writeJson(fileIn(dataDir), all)
}

/** Main-process only: the decrypted key, or undefined. Never send it to the renderer. */
export function getSecret(id: SecretId, dataDir = defaultDir()): string | undefined {
  return decrypt(readJson<SecretFile>(fileIn(dataDir), {})[id])
}

/** Store one secret of the player's MCP server (an environment variable or header value). */
export function setMcpSecret(server: string, name: string, value: string, dataDir = defaultDir()): void {
  const key = mcpKey(server, name)
  const v = value.trim()
  if (!v) throw new Error('The secret is empty.')
  assertEncryption()
  const all = readJson<SecretFile>(fileIn(dataDir), {})
  all[key] = { enc: safeStorage.encryptString(v).toString('base64'), setAt: nowIso() }
  writeJson(fileIn(dataDir), all)
}

/** Main-process only: one MCP server secret, or undefined. Only the gateway passes it on, to that server. */
export function getMcpSecret(server: string, name: string, dataDir = defaultDir()): string | undefined {
  return decrypt(readJson<SecretFile>(fileIn(dataDir), {})[mcpKey(server, name)])
}

/** Which of the server's secrets have a stored value. */
export function mcpSecretsSet(server: string, names: string[], dataDir = defaultDir()): Record<string, boolean> {
  const all = readJson<SecretFile>(fileIn(dataDir), {})
  return Object.fromEntries(names.map((n) => [n, Boolean(all[mcpKey(server, n)]?.enc)]))
}

/** Delete the server's stored secrets, all of them or all but `keep`. */
export function clearMcpSecrets(server: string, keep: string[] = [], dataDir = defaultDir()): void {
  const prefix = mcpKey(server, 'x').slice(0, -1)
  const all = readJson<SecretFile>(fileIn(dataDir), {})
  const drop = Object.keys(all).filter((k) => k.startsWith(prefix) && !keep.includes(k.slice(prefix.length)))
  if (!drop.length) return
  for (const k of drop) delete all[k]
  writeJson(fileIn(dataDir), all)
}

const oauthKey = (server: string): string => {
  if (!/^[\w-]+$/.test(server)) throw new Error('Unknown MCP server.')
  return `mcp-oauth:${server}`
}

/** Main-process only: a server's Genio sign-in (client registration and tokens, mcp-signin.ts), or undefined. */
export function getMcpOAuth<T>(server: string, dataDir = defaultDir()): T | undefined {
  const text = decrypt(readJson<SecretFile>(fileIn(dataDir), {})[oauthKey(server)])
  if (!text) return undefined
  try { return JSON.parse(text) as T } catch { return undefined }
}

export function setMcpOAuth(server: string, value: unknown, dataDir = defaultDir()): void {
  const key = oauthKey(server)
  assertEncryption()
  const all = readJson<SecretFile>(fileIn(dataDir), {})
  all[key] = { enc: safeStorage.encryptString(JSON.stringify(value)).toString('base64'), setAt: nowIso() }
  writeJson(fileIn(dataDir), all)
}

export const hasMcpOAuth = (server: string, dataDir = defaultDir()): boolean => Boolean(readJson<SecretFile>(fileIn(dataDir), {})[oauthKey(server)]?.enc)

export function clearMcpOAuth(server: string, dataDir = defaultDir()): void {
  const key = oauthKey(server)
  const all = readJson<SecretFile>(fileIn(dataDir), {})
  if (!(key in all)) return
  delete all[key]
  writeJson(fileIn(dataDir), all)
}

export function secretStatus(dataDir = defaultDir()): ApiKeyStatus[] {
  const all = readJson<SecretFile>(fileIn(dataDir), {})
  return SECRET_SERVICES.map((s) => {
    const rec = all[s.id]
    return { id: s.id, label: s.label, purpose: s.purpose, set: Boolean(rec?.enc), last4: rec?.last4, setAt: rec?.setAt }
  })
}
