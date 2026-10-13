import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import { expect, it } from 'vitest'
import { ACHIEVEMENTS } from '../src/main/stats'

function files(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(root, entry.name)
    return entry.isDirectory() ? files(file) : [file]
  })
}

// Compatibility vocabulary is limited to keys, tool names, CSS classes, paths,
// enum values and CLI options. It must never exempt display labels or prose.
function visibleStrings(source: string): string[] {
  const result: string[] = []
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
  const visit = (node: any, parent?: any): void => {
    if (!node || typeof node !== 'object') return
    if (['StringLiteral', 'TemplateElement', 'JSXText'].includes(node.type)) {
      const text = source.slice(node.start, node.end)
      const display = node.type === 'JSXText' || parent?.type === 'JSXAttribute' && !['className', 'id'].includes(parent.name.name)
        || parent?.type === 'ObjectProperty' && ['name', 'label', 'title', 'description', 'hint'].includes(parent.key.name)
      const internal = ['TSLiteralType', 'ImportDeclaration', 'ExportNamedDeclaration'].includes(parent?.type)
        || parent?.type === 'JSXAttribute' && ['className', 'id'].includes(parent.name.name)
        || parent?.type === 'ObjectProperty' && ['id', 'feature'].includes(parent.key.name)
        || !display && /^["'`]?(?:worlds?|[\w./:@$-]*world[\w./:@$-]*)["'`]?$/.test(text)
      if (!internal) result.push(text)
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'extra', 'comments', 'tokens'].includes(key)) continue
      if (Array.isArray(value)) value.forEach(child => visit(child, node))
      else if (value && typeof value === 'object') visit(value, node)
    }
  }
  visit(ast)
  return result
}

const prose = (text: string) => text
  .replace(/^\s*world\s+--/gm, '  --') // existing FAL subcommand
  .replace(/--(?:no-)?world\b/g, '') // existing CLI flags
  .replace(/genio-world\.mjs/g, '') // bundled helper filename


it('uses project in UI, errors, contracts, agent descriptions and documentation', () => {
  const violations: string[] = []
  for (const file of [...files('src'), ...files('resources')].filter(file => /\.(tsx?|mjs)$/.test(file))) {
    for (const text of visibleStrings(fs.readFileSync(file, 'utf8'))) {
      if (/\bworlds?\b/i.test(prose(text))) violations.push(`${file}: ${text.trim()}`)
    }
  }
  for (const file of ['README.md', ...files('docs'), ...files('resources')].filter(file => file.endsWith('.md'))) {
    // Code spans document actual API keys, CLI flags and on-disk formats.
    const text = fs.readFileSync(file, 'utf8').replace(/`[^`]*`/g, '')
    if (/\bworlds?\b/i.test(prose(text))) violations.push(file)
  }
  expect(violations).toEqual([])
})

it('guards achievement display text while retaining persisted achievement ids', () => {
  for (const achievement of ACHIEVEMENTS) expect(`${achievement.name} ${achievement.description}`).not.toMatch(/\bworlds?\b/i)
  expect(ACHIEVEMENTS.some(achievement => achievement.id === 'world-first')).toBe(true)
})

it('detects single-word display labels and prose without flagging internal keys', () => {
  expect(visibleStrings('const label = <span>world</span>')).toContain('world')
  expect(visibleStrings('const item = { label: "Worlds" }')).toContain('"Worlds"')
  expect(visibleStrings('type View = "worlds"; const key = "world"')).toEqual([])
})
