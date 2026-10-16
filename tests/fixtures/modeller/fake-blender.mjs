// A stand-in for blender.exe that speaks genio_step.py's plan protocol, for tests without Blender.
// The runner calls: node fake-blender.mjs -b ... [snapshot.blend] --python genio_step.py -- plan.json
// A "snapshot" is the zstd magic plus JSON {parts, scripts}. Step scripts drive it with comments:
//   # part: <name>     add a part        # remove: <name>   drop a part
//   # fake: error      raise              # fake: crash      exit 3 mid-step
//   # fake: hang       never finish
import fs from 'node:fs'
import path from 'node:path'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const argv = process.argv.slice(2)
const blend = argv.slice(0, argv.indexOf('--python')).find((a) => a.endsWith('.blend'))
const plan = JSON.parse(fs.readFileSync(argv[argv.indexOf('--') + 1], 'utf8'))
const state = blend ? JSON.parse(fs.readFileSync(blend).subarray(4).toString('utf8')) : { parts: [], scripts: [] }
const receipt = { schema: 'genio.modeller-step.v1', ok: false, ...plan.step, blender: 'fake', api_warnings: [], replayed: plan.replay.length, base: blend ?? null }
const out = (name) => path.join(plan.out, name)
const captionOf = (code) => code.match(/^"""(.*?)(?:"""|$)/m)?.[1]?.trim() || null

function finish(code) {
  fs.writeFileSync(out('receipt.json'), JSON.stringify(receipt))
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
  return true
}

function main() {
  for (const file of plan.replay) apply(file, 'replay')
  if (plan.script && !apply(plan.script, 'error')) {
    setInterval(() => {}, 1000) // a hung step: only the watchdog ends it
    return
  }
  const outputs = new Set(plan.outputs)
  if (outputs.has('blend')) fs.writeFileSync(out('model.blend'), Buffer.concat([MAGIC, Buffer.from(JSON.stringify(state))]))
  if (plan.script) {
    const caption = captionOf(fs.readFileSync(plan.script, 'utf8'))
    if (outputs.has('glb')) fs.writeFileSync(out('model.glb'), JSON.stringify(state.parts))
    if (outputs.has('sheet')) { fs.writeFileSync(out('sheet.png'), PNG); fs.writeFileSync(out('view.png'), PNG) }
    Object.assign(receipt, {
      caption, triangles: state.parts.length * 12, vertices: state.parts.length * 8, objects: state.parts.length,
      parts: state.parts.map((name) => ({ name, triangles: 12 })), bounds: { min: [0, 0, 0], max: [1, 1, 1], dimensions: [1, 1, 1] },
      warnings: caption ? [] : ['Start the step script with a docstring: its first line is the caption the player sees.']
    })
  }
  receipt.ok = true
  finish(0)
}

main()
