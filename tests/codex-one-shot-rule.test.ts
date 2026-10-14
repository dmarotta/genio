import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'

// Rule: a Codex call that does not need its thread afterwards runs ephemeral
// (`codex exec --ephemeral`, app-server `thread/start` with `ephemeral: true`),
// so it never lists in the player's Codex apps. Durable threads are listed here
// with the reason they must persist; despawned units' threads are archived.
const DURABLE: Record<string, string> = {
  'resources/unit-skills/genio/skills/imagegen-codex/scripts/codex-image.mjs': 'reads savedPath and the plan meter from its rollout; `exec` threads are already hidden by Codex apps',
  'src/main/codex-chat-driver.ts': 'the chat thread is resumed across restarts'
}

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sources(p, out)
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(e.name)) out.push(p)
  }
  return out
}

it('starts every new one-shot Codex thread ephemeral', () => {
  const root = path.join(__dirname, '..')
  const offenders: string[] = []
  for (const file of [...sources(path.join(root, 'src')), ...sources(path.join(root, 'resources')), ...sources(path.join(root, 'scripts'))]) {
    const rel = path.relative(root, file).split(path.sep).join('/')
    const text = fs.readFileSync(file, 'utf8')
    if (!/codex/i.test(text)) continue
    const starts = text.split('\n').filter(line => /['"]exec['"]|thread\/start/.test(line))
    if (starts.length && !DURABLE[rel] && !starts.every(line => /--ephemeral|ephemeral:\s*true/.test(line))) offenders.push(rel)
  }
  expect(offenders).toEqual([])
  for (const rel of Object.keys(DURABLE)) expect(fs.existsSync(path.join(root, rel))).toBe(true)
})
