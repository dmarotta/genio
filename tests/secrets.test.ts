import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fake OS-backed encryption: reversible, but never stores the plain text.
const safe = vi.hoisted(() => ({ available: true }))
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => safe.available,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (s: string) => Buffer.from('enc:' + Buffer.from(s, 'utf8').toString('hex'), 'utf8'),
    decryptString: (b: Buffer) => {
      const t = b.toString('utf8')
      if (!t.startsWith('enc:')) throw new Error('bad cipher text')
      return Buffer.from(t.slice(4), 'hex').toString('utf8')
    }
  }
}))

import { clearSecret, getSecret, secretStatus, setSecret } from '../src/main/secrets'

const KEY = 'fal-key-1234abcd:0123456789abcdefWXYZ'
let dir: string

beforeEach(() => {
  safe.available = true
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-secrets-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('secret store', () => {
  it('round-trips a key without writing it in plain text', () => {
    expect(secretStatus(dir)).toEqual([expect.objectContaining({ id: 'fal', set: false }), expect.objectContaining({ id: 'openrouter', set: false })])
    setSecret('fal', `  ${KEY}\n`, dir)
    expect(getSecret('fal', dir)).toBe(KEY)
    const raw = fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')
    expect(raw).not.toContain(KEY)
    expect(raw).not.toContain('0123456789abcdef')
    const st = secretStatus(dir).find((s) => s.id === 'fal')!
    expect(secretStatus(dir).find((s) => s.id === 'openrouter')?.set).toBe(false)
    expect(st).toMatchObject({ id: 'fal', label: 'FAL.ai', set: true, last4: 'WXYZ' })
    expect(JSON.stringify(st)).not.toContain(KEY)
  })

  it('replaces and clears', () => {
    setSecret('fal', KEY, dir)
    setSecret('fal', 'another-fal-key-000000-LAST', dir)
    expect(getSecret('fal', dir)).toBe('another-fal-key-000000-LAST')
    clearSecret('fal', dir)
    expect(getSecret('fal', dir)).toBeUndefined()
    expect(secretStatus(dir)[0].set).toBe(false)
  })

  it('refuses without OS encryption, empty keys and unknown services', () => {
    safe.available = false
    expect(() => setSecret('fal', KEY, dir)).toThrow(/encryption/i)
    expect(fs.existsSync(path.join(dir, 'secrets.json'))).toBe(false)
    safe.available = true
    expect(() => setSecret('fal', '   ', dir)).toThrow(/empty/i)
    expect(() => setSecret('openai', KEY, dir)).toThrow(/Unknown/)
  })

  it('errors never echo the key', () => {
    safe.available = false
    try {
      setSecret('fal', KEY, dir)
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(KEY)
    }
  })
})
