/**
 * API keys for services that have no CLI login (FAL.ai, OpenRouter, Uthana). The one deliberate
 * exception to "Genio keeps no credentials": each key is encrypted with
 * Electron safeStorage (OS-backed: DPAPI / Keychain / libsecret) and kept in
 * the main base's data/secrets.json, never in a world or in settings.json.
 * Keys are never logged or returned to the renderer; only "set" and the last
 * four characters are.
 */
import path from 'node:path'
import { safeStorage } from 'electron'
import type { ApiKeyStatus } from '@shared/api'
import { defaultHomeRoot } from './home'
import { nowIso, readJson, writeJson } from './util'

export const SECRET_SERVICES = [
  { id: 'fal', label: 'FAL.ai', purpose: 'Generative media API (images, audio, video)' },
  { id: 'openrouter', label: 'OpenRouter', purpose: 'Cheap third-party coding models for OpenCode units, only in worlds that allow them' },
  { id: 'uthana', label: 'Uthana', purpose: '3D character animation API for the Animation screen (text/video to motion, rigging, retargeting)' }
] as const
export type SecretId = (typeof SECRET_SERVICES)[number]['id']

interface SecretRecord {
  /** base64 of safeStorage.encryptString(key) */
  enc: string
  last4?: string
  setAt: string
}

type SecretFile = Partial<Record<SecretId, SecretRecord>>

const defaultDir = (): string => path.join(defaultHomeRoot(), 'data')
const fileIn = (dataDir: string): string => path.join(dataDir, 'secrets.json')

function assertId(id: string): asserts id is SecretId {
  if (!SECRET_SERVICES.some((s) => s.id === id)) throw new Error(`Unknown API key service: ${id}`)
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
  const rec = readJson<SecretFile>(fileIn(dataDir), {})[id]
  if (!rec?.enc || !safeStorage.isEncryptionAvailable()) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(rec.enc, 'base64'))
  } catch {
    return undefined
  }
}

export function secretStatus(dataDir = defaultDir()): ApiKeyStatus[] {
  const all = readJson<SecretFile>(fileIn(dataDir), {})
  return SECRET_SERVICES.map((s) => {
    const rec = all[s.id]
    return { id: s.id, label: s.label, purpose: s.purpose, set: Boolean(rec?.enc), last4: rec?.last4, setAt: rec?.setAt }
  })
}
