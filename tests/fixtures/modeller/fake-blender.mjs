// A stand-in for blender.exe that speaks genio_step.py's plan protocol, for tests without Blender.
// The runner calls: node fake-blender.mjs -b ... [snapshot.blend] --python genio_step.py -- plan.json
// (plan.steps runs back to back in this one process, as in Blender).
// A "snapshot" is the zstd magic plus JSON {parts, scripts}. Step scripts drive it with comments:
//   # part: <name>     add a part        # remove: <name>   drop a part
//   # fake: error      raise              # fake: crash      exit 3 mid-step
//   # fake: hang       never finish
// A `p.bake_maps(` call lists one bake in the receipt, as genio_parts does; receipts carry the
// --threads Blender was started with.
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

/** Runs one script against the state; returns false when it hangs. */
function apply(file, kind) {
  const code = fs.readFileSync(file, 'utf8')
  if (code.includes('# fake: hang')) return false
  if (code.includes('# fake: crash')) process.exit(3)
  if (code.includes('# fake: error')) {
    Object.assign(receipt, { kind, error: 'RuntimeError: fake failure', trace: [`${path.basename(file)}:2: raise RuntimeError`], caption: captionOf(code) })
    finish(kind === 'error' ? 3 : 4)
  }
  for (const m of code.matchAll(/^# remove: (.+)$/gm)) state.parts = state.parts.filter((p) => p !== m[1].trim())
  for (const m of code.matchAll(/^# part: (.+)$/gm)) if (!state.parts.includes(m[1].trim())) state.parts.push(m[1].trim())
  state.scripts.push(captionOf(code) ?? path.basename(file))
  if (kind === 'error' && /\bp\.bake_maps\(/.test(code)) {
    const size = Number(code.match(/bake_maps\(.*size=(\d+)/)?.[1] ?? 1024)
    receipt.bakes = [{ parts: state.parts.length, materials: 1, size, samples: 8, device: 'CPU', threads, bakes: 2, bake_s: { basecolor: 0.1, roughmetal: 0.1 }, total_s: 0.3, files: {}, material: 'Baked' }]
  }
  return true
}

async function main() {
  for (const [i, item] of plan.steps.entries()) {
    receipt = { schema: 'genio.modeller-step.v1', ok: false, ...item.step, blender: 'fake', api_warnings: [], replayed: plan.replay.length, base: blend ?? null, batch_index: i, threads }
    out = (name) => path.join(item.out, name)
    fs.mkdirSync(item.out, { recursive: true })
    if (i === 0) for (const file of plan.replay) apply(file, 'replay')
    if (item.script && !apply(item.script, 'error')) {
      setInterval(() => {}, 1000) // a hung step: only the watchdog ends it
      return
    }
    const outputs = new Set(item.outputs)
    if (outputs.has('blend')) fs.writeFileSync(out('model.blend'), Buffer.concat([MAGIC, Buffer.from(JSON.stringify(state))]))
    if (item.script) {
      const caption = captionOf(fs.readFileSync(item.script, 'utf8'))
      if (outputs.has('glb')) fs.writeFileSync(out('model.glb'), JSON.stringify(state.parts))
      if (outputs.has('sheet')) { fs.writeFileSync(out('sheet.png'), PNG); fs.writeFileSync(out('view.png'), PNG) }
      Object.assign(receipt, {
        caption, triangles: state.parts.length * 12, vertices: state.parts.length * 8, objects: state.parts.length,
        parts: state.parts.map((name) => ({ name, triangles: 12 })), bounds: { min: [0, 0, 0], max: [1, 1, 1], dimensions: [1, 1, 1] },
        warnings: caption ? [] : ['Start the step script with a docstring: its first line is the caption the player sees.']
      })
    }
    receipt.ok = true
    writeReceipt()
    if (pace) await new Promise((r) => setTimeout(r, pace))
  }
  process.exit(0)
}

main()
