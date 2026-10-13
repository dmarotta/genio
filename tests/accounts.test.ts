import { describe, expect, it } from 'vitest'
import {
  parseClaudeAuth, parseCodexLogin, parseCursorStatus, parseGhAuth, parseGlabAuth, parseOpencodeAuth, scrubDetail
} from '../src/main/accounts'

describe('parseClaudeAuth', () => {
  it('reads the JSON status', () => {
    const out = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'player@example.com', orgId: 'x', subscriptionType: 'max' }, null, 2)
    expect(parseClaudeAuth(out)).toEqual({ state: 'logged-in', detail: 'claude.ai (max) · player@example.com' })
  })

  it('reports logged out', () => {
    expect(parseClaudeAuth('{\n  "loggedIn": false,\n  "authMethod": "none"\n}')).toEqual({ state: 'logged-out' })
  })

  it('falls back to the text form', () => {
    expect(parseClaudeAuth('Login method: Claude Max account\nEmail: player@example.com\n')).toEqual({ state: 'logged-in', detail: 'Claude Max account · player@example.com' })
    expect(parseClaudeAuth('Not logged in. Run claude auth login')).toEqual({ state: 'logged-out' })
    expect(parseClaudeAuth('something unexpected')).toEqual({ state: 'unknown' })
  })
})

describe('parseCodexLogin', () => {
  it('reads ChatGPT and logged-out states', () => {
    expect(parseCodexLogin('\nLogged in using ChatGPT\n')).toEqual({ state: 'logged-in', detail: 'ChatGPT' })
    expect(parseCodexLogin('Not logged in\n')).toEqual({ state: 'logged-out' })
  })

  it('never surfaces the masked API key', () => {
    const p = parseCodexLogin('Logged in using an API key - sk-proj-***ABCDE')
    expect(p).toEqual({ state: 'logged-in', detail: 'API key' })
  })
})

describe('parseGhAuth', () => {
  it('lists accounts and drops token lines', () => {
    const out = [
      'github.com',
      '  ✓ Logged in to github.com account octocat (keyring)',
      '  - Active account: true',
      '  - Git operations protocol: https',
      "  - Token: gho_************************************",
      "  - Token scopes: 'gist', 'read:org', 'repo'"
    ].join('\n')
    const p = parseGhAuth(out)
    expect(p).toEqual({ state: 'logged-in', detail: 'octocat @ github.com' })
    expect(p.detail).not.toMatch(/gho_|\*/)
  })

  it('handles the older "as" form, logged out and invalid tokens', () => {
    expect(parseGhAuth('github.com\n  ✓ Logged in to github.com as octocat (oauth_token)')).toEqual({ state: 'logged-in', detail: 'octocat @ github.com' })
    expect(parseGhAuth('You are not logged into any GitHub hosts. To log in, run: gh auth login')).toEqual({ state: 'logged-out' })
    expect(parseGhAuth('github.com\n  X Failed to log in to github.com account octocat (keyring)').state).toBe('logged-out')
  })
})

describe('parseGlabAuth', () => {
  it('reads accounts and logged-out', () => {
    const out = 'gitlab.com\n  ✓ Logged in to gitlab.com as player (/home/p/.config/glab-cli/config.yml)\n  ✓ Token: **************************'
    expect(parseGlabAuth(out)).toEqual({ state: 'logged-in', detail: 'player @ gitlab.com' })
    expect(parseGlabAuth('x gitlab.com has not been authenticated with glab. Run `glab auth login gitlab.com`').state).toBe('logged-out')
    expect(parseGlabAuth('')).toEqual({ state: 'unknown' })
  })
})

describe('parseCursorStatus', () => {
  it('reads the account and logged-out', () => {
    expect(parseCursorStatus('✓ Logged in as player@example.com')).toEqual({ state: 'logged-in', detail: 'player@example.com' })
    expect(parseCursorStatus('Not logged in')).toEqual({ state: 'logged-out' })
  })
})

describe('parseOpencodeAuth', () => {
  it('lists stored providers only, not environment variables', () => {
    const out = [
      '┌  Credentials ~/.local/share/opencode/auth.json',
      '│',
      '●  Anthropic oauth',
      '│',
      '●  OpenAI api',
      '│',
      '└  2 credentials',
      '',
      '┌  Environment',
      '│',
      '●  Google GEMINI_API_KEY',
      '│',
      '└  1 environment variable'
    ].join('\n')
    expect(parseOpencodeAuth(out)).toEqual({ state: 'logged-in', detail: 'Anthropic oauth, OpenAI api' })
  })

  it('reports no credentials as logged out', () => {
    expect(parseOpencodeAuth('┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials')).toEqual({ state: 'logged-out' })
  })
})

describe('scrubDetail', () => {
  it('removes token-shaped strings', () => {
    expect(scrubDetail('octocat ghp_abcdefghijklmnop')).toBe('octocat')
    expect(scrubDetail('key sk-ant-api03-xyz')).toBe('key')
    expect(scrubDetail('masked ****abcd')).toBe('masked')
    expect(scrubDetail('blob ' + 'A'.repeat(40))).toBe('blob')
    expect(scrubDetail('')).toBeUndefined()
  })
})
