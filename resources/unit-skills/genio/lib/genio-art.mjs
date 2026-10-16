#!/usr/bin/env node
/**
 * genio-art: read and compile a project's Art Bible (.genio/art-bible.md).
 * Node 18+, standard library only. No network, no cost, never writes.
 *
 * Every command prints one JSON document on stdout.
 * Exit codes: 0 ok, 2 usage, 3 the bible has errors.
 */
import fs from 'node:fs'
import { ArtBibleError, BIBLE_FILE, compile, loadArtBible, selectRefs, summarize } from './art-bible.mjs'

const EXIT = { usage: 2, invalid: 3 }

const USAGE = `Usage: node genio-art.mjs <command> --world <project root> [options]
  show     [--brief]            the resolved bible, with the file behind every part (origins)
  compile  [--type <t>] [--provider codex|fal|uthana] [--endpoint <id>] [--schema <input schema.json>]
           [--subject <text>] [--style-id <id>] [--limit <chars>]
                                what one generation gets: prompt (subject first), refs, params, notes
  refs     [--type <t>] [--limit <n>]   references for an asset type, best first
  check                         sizes, front matter, source and missing references
Without ${BIBLE_FILE} (or with an empty one) there is no bible and compile returns null.
In a unit, GENIO_ART_BIBLE (the bible as of its launch) is read instead of the world's file.`

class Usage extends Error {}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const opts = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith('--')) throw new Usage(`Unexpected argument: ${a}`)
    const eq = a.indexOf('=')
    if (eq > 0) opts[a.slice(2, eq)] = a.slice(eq + 1)
    else if (i + 1 < rest.length && !rest[i + 1].startsWith('--')) opts[a.slice(2)] = rest[++i]
    else opts[a.slice(2)] = true
  }
  return { command, opts }
}

/** A unit's GENIO_ART_BIBLE (its launch snapshot) stands in for the world's file, as in the generators. */
function load(opts) {
  if (typeof opts.world !== 'string' || !opts.world.trim()) throw new Usage('Missing --world <project root>.')
  return loadArtBible(opts.world, { file: process.env.GENIO_ART_BIBLE || undefined })
}

const num = (v, name) => {
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1) throw new Usage(`--${name} must be a positive whole number.`)
  return n
}

const COMMANDS = {
  show(opts) {
    const bible = load(opts)
    if (!bible) return { bible: null }
    return opts.brief ? summarize(bible) : bible
  },
  compile(opts) {
    let schema
    if (typeof opts.schema === 'string') {
      try {
        schema = JSON.parse(fs.readFileSync(opts.schema, 'utf8').replace(/^﻿/, ''))
      } catch (e) {
        throw new Usage(`--schema ${opts.schema}: ${e.message}`)
      }
    }
    const bible = load(opts)
    return compile({ bible, type: opts.type, provider: opts.provider, endpoint: opts.endpoint, schema, subject: typeof opts.subject === 'string' ? opts.subject : '', styleId: opts['style-id'], limit: num(opts.limit, 'limit') })
  },
  refs(opts) {
    const bible = load(opts)
    return { type: opts.type ?? null, refs: selectRefs(bible, opts.type, num(opts.limit, 'limit') ?? 24) }
  },
  check(opts) {
    const bible = load(opts)
    if (!bible) return { ok: true, bible: null }
    const ok = !bible.issues.some((i) => i.level === 'error')
    return { ok, summary: summarize(bible), issues: bible.issues }
  }
}

function main() {
  const { command, opts } = parseArgs(process.argv.slice(2))
  if (!command || command === 'help' || opts.help) {
    process.stdout.write(USAGE + '\n')
    return 0
  }
  const fn = COMMANDS[command]
  if (!fn) throw new Usage(`Unknown command "${command}".\n${USAGE}`)
  const out = fn(opts)
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  return command === 'check' && out.ok === false ? EXIT.invalid : 0
}

try {
  process.exitCode = main()
} catch (e) {
  const code = e instanceof Usage ? EXIT.usage : e instanceof ArtBibleError ? EXIT.invalid : 1
  process.stderr.write(JSON.stringify({ error: e instanceof Usage || e instanceof ArtBibleError ? e.message : `${e?.code ?? e?.name ?? 'Error'}: ${e?.message ?? e}` }, null, 2) + '\n')
  process.exitCode = code
}
