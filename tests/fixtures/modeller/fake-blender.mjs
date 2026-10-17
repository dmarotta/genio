// A stand-in for blender.exe that speaks genio_step.py's plan protocol, for tests without Blender.
// The runner calls: node fake-blender.mjs -b ... [snapshot.blend] --python genio_step.py -- plan.json
// (plan.steps runs back to back in this one process, as in Blender).
// A "snapshot" is the zstd magic plus JSON {parts, scripts}. Step scripts drive it with comments:
//   # part: <name>     add a part        # remove: <name>   drop a part
//   # warn: <text>     the step's checks report this warning
//   # review: <text>   the step's text review has this line
//   # fake: error      raise              # fake: crash      exit 3 mid-step
//   # fake: hang       never finish
//   # fake: wait-publish   after landed.json, wait (up to 10 s) until the kernel published the
//                          step before writing the sheet; the receipt says sheet_after_publish
//   # fake: sheet-error    the sheet fails: a warning, no sheet, the step stays ok
//   # fake: crash-after-glb  exit 3 right after landed.json (no snapshot, sheet or receipt)
//   # use: <helper>    a NameError unless the step's lib.py has `# def: <helper>`
// A step's lib.py (plan step `lib`, replay `{script, lib}`) runs first: its `# def:` lines define
// helpers for that one script, `# fake: error` raises in the lib, and the snapshot's `scripts` list
// records the lib's caption as `<script caption> + lib <lib caption>`.
// As genio_step.py, a step with parts writes landed.json right after its GLB, then the rest.
// A `p.bake_maps(` call lists one bake in the receipt, as genio_parts does; receipts carry the
// --threads Blender was started with, and the first step's receipt the parent parts the kernel
// passed for its review (`previous`).
import fs from 'node:fs'
import path from 'node:path'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const argv = process.argv.slice(2)
const blend = argv.slice(0, argv.indexOf('--python')).find((a) => a.endsWith('.blend'))
const plan = JSON.parse(fs.readFileSync(argv[argv.indexOf('--') + 1], 'utf8'))
const state = blend ? JSON.parse(fs.readFileSync(blend).subarray(4).toString('utf8')) : { parts: [], scripts: [] }
const threads = Number(argv[argv.indexOf('--threads') + 1])
const captionOf = (code) => code.match(/^"""(.*?)(?:"""|$)/m)?.[1]?.trim() || null
// A batch's steps run back to back, each published by its receipt; FAKE_BLENDER_STEP_MS paces them.
const pace = Number(process.env.FAKE_BLENDER_STEP_MS) || 0
let receipt, out

function writeReceipt() {
  fs.writeFileSync(out('receipt.json.tmp'), JSON.stringify(receipt))
  fs.renameSync(out('receipt.json.tmp'), out('receipt.json'))
}

function finish(code) {
  writeReceipt()
  process.exit(code)
}

/** Runs one script (after its lib.py, when it has one) against the state; returns false when it hangs. */
function apply(file, kind, lib) {
  const code = fs.readFileSync(file, 'utf8')
  const libCode = lib ? fs.readFileSync(lib, 'utf8') : ''
  const fail = (error, trace) => {
    Object.assign(receipt, { kind, error, trace, caption: captionOf(code) })
    finish(kind === 'error' ? 3 : 4)
  }
  if (libCode.includes('# fake: error')) fail('RuntimeError: fake lib failure', ['lib.py:2: raise RuntimeError'])
  const defined = new Set([...libCode.matchAll(/^# def: (.+)$/gm)].map((m) => m[1].trim()))
  if (code.includes('# fake: hang')) return false
  if (/^# fake: crash\s*$/m.test(code)) process.exit(3)
  if (code.includes('# fake: error')) fail('RuntimeError: fake failure', [`${path.basename(file)}:2: raise RuntimeError`])
  for (const m of code.matchAll(/^# use: (.+)$/gm)) if (!defined.has(m[1].trim())) fail(`NameError: name '${m[1].trim()}' is not defined`, [`${path.basename(file)}:2: ${m[1].trim()}()`])
  for (const m of code.matchAll(/^# remove: (.+)$/gm)) state.parts = state.parts.filter((p) => p !== m[1].trim())
  for (const m of code.matchAll(/^# part: (.+)$/gm)) if (!state.parts.includes(m[1].trim())) state.parts.push(m[1].trim())
  const caption = captionOf(code) ?? path.basename(file)
  state.scripts.push(lib ? `${caption} + lib ${captionOf(libCode) ?? 'lib.py'}` : caption)
  if (kind === 'error' && /\bp\.bake_maps\(/.test(code)) {
    const size = Number(code.match(/bake_maps\(.*size=(\d+)/)?.[1] ?? 1024)
    receipt.bakes = [{ parts: state.parts.length, materials: 1, size, samples: 8, device: 'CPU', threads, bakes: 2, bake_s: { basecolor: 0.1, roughmetal: 0.1 }, total_s: 0.3, files: {}, material: 'Baked' }]
  }
  return true
}

/** Whether the kernel made this step the head, with its GLB in steps/<id>/, within 10 s. */
async function published(item) {
  const model = path.dirname(path.dirname(item.out))
  for (const until = Date.now() + 10000; Date.now() < until; await new Promise((r) => setTimeout(r, 20))) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(model, 'manifest.json'), 'utf8'))
      if (m.branches[m.branch].head === item.step.id && fs.existsSync(path.join(model, 'steps', item.step.id, 'model.glb'))) return true
    } catch { /* mid-write */ }
  }
  return false
}

async function main() {
  for (const [i, item] of plan.steps.entries()) {
    receipt = { schema: 'genio.modeller-step.v1', ok: false, ...item.step, blender: 'fake', api_warnings: [], replayed: plan.replay.length, base: blend ?? null, batch_index: i, threads }
    out = (name) => path.join(item.out, name)
    fs.mkdirSync(item.out, { recursive: true })
    if (i === 0) for (const r of plan.replay) apply(r.script ?? r, 'replay', r.lib)
    if (item.script && !apply(item.script, 'error', item.lib)) {
      setInterval(() => {}, 1000) // a hung step: only the watchdog ends it
      return
    }
    const outputs = new Set(item.outputs)
    const code = item.script ? fs.readFileSync(item.script, 'utf8') : ''
    const caption = item.script ? captionOf(code) : null
    if (item.script && outputs.has('glb') && state.parts.length) {
      fs.writeFileSync(out('model.glb'), JSON.stringify(state.parts))
      fs.writeFileSync(out('landed.json.tmp'), JSON.stringify({ ok: true, stage: 'glb', ...item.step, caption }))
      fs.renameSync(out('landed.json.tmp'), out('landed.json'))
      if (code.includes('# fake: crash-after-glb')) process.exit(3)
    }
    if (outputs.has('blend')) fs.writeFileSync(out('model.blend'), Buffer.concat([MAGIC, Buffer.from(JSON.stringify(state))]))
    if (item.script) {
      const warnings = caption ? [] : ['Start the step script with a docstring: its first line is the caption the player sees.']
      for (const m of code.matchAll(/^# warn: (.+)$/gm)) warnings.push(m[1].trim())
      const review = [...code.matchAll(/^# review: (.+)$/gm)].map((m) => m[1].trim())
      if (code.includes('# fake: wait-publish')) receipt.sheet_after_publish = await published(item)
      if (outputs.has('sheet') && code.includes('# fake: sheet-error')) warnings.push('The review sheet failed (RuntimeError: fake sheet failure); the step is published without it.')
      else if (outputs.has('sheet')) { fs.writeFileSync(out('sheet.png'), PNG); fs.writeFileSync(out('view.png'), PNG) }
      Object.assign(receipt, {
        caption, triangles: state.parts.length * 12, vertices: state.parts.length * 8, objects: state.parts.length,
        parts: state.parts.map((name) => ({ name, triangles: 12 })), bounds: { min: [0, 0, 0], max: [1, 1, 1], dimensions: [1, 1, 1] },
        warnings, review, ...(i === 0 ? { previous: item.previous } : {})
      })
    }
    receipt.ok = true
    writeReceipt()
    if (pace) await new Promise((r) => setTimeout(r, pace))
  }
  process.exit(0)
}

main()
