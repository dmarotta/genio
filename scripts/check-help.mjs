#!/usr/bin/env node
/**
 * Build step: the help set genio_help ships (docs/help/help-set.json) must be complete. Fails when a
 * listed doc is missing or empty, or a link in one of them points at a doc that does not exist.
 * Usage: node scripts/check-help.mjs [docs folder]. Standard library only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const docs = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs'))
const problems = []
let listed = []
try {
  listed = JSON.parse(fs.readFileSync(path.join(docs, 'help', 'help-set.json'), 'utf8')).docs ?? []
} catch (e) {
  problems.push(`docs/help/help-set.json cannot be read: ${e.message}`)
}
for (const doc of listed) {
  const file = path.join(docs, doc)
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { problems.push(`listed doc is missing: docs/${doc}`); continue }
  const text = fs.readFileSync(file, 'utf8')
  if (!text.trim()) problems.push(`listed doc is empty: docs/${doc}`)
  for (const [, target] of text.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
    if (/^[a-z]+:/i.test(target)) continue
    if (!fs.existsSync(path.resolve(path.dirname(file), target))) problems.push(`docs/${doc} links to a missing doc: ${target}`)
  }
}
if (problems.length) {
  console.error(`Genio help set is incomplete:\n- ${problems.join('\n- ')}`)
  process.exit(1)
}
console.log(`Genio help set: ${listed.length} docs OK`)
