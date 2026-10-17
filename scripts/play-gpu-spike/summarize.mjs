// Builds the smoke's results table from <results>/*.json (one per consumer run, with the editor's side inside).
// Latency is from Unity's end of frame (t0, logged per frame number by SpikeScene) to the renderer's drawImage. Both
// paths carry the frame number: GPU frames in their message, JPEG frames in the blocks read back from the image.
// CPU: Electron's percentCPUUsage is a share of all logical CPUs, so × cores gives % of one core.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir = process.argv[2], cores = os.cpus().length
const stat = v => {
  if (!v.length) return undefined
  const s = [...v].sort((a, b) => a - b), at = p => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return { n: s.length, p50: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2), max: +s.at(-1).toFixed(2) }
}
const pct = v => v === undefined ? '—' : (v * cores).toFixed(1)
const rows = [], details = {}
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
  if (!j.renderer) { rows.push(`| ${j.label} | failed: ${j.failed} |`); continue }
  const t0 = new Map((j.unity?.frames ?? []).map(([n, t]) => [n, t * 1000]))
  const recs = j.renderer.records
  const e2e = [], toMain = [], mainToDrawn = []
  let matched = 0
  for (const r of recs) {
    const start = t0.get(r.seq)
    if (start === undefined) continue
    matched++
    e2e.push((r.tDrawn - start) / 1000)
    if (r.tMain) { toMain.push((r.tMain - start) / 1000); mainToDrawn.push((r.tDrawn - r.tMain) / 1000) }
  }
  const paths = [...new Set(recs.map(r => r.path))].join('→')
  // A switch of size or path: the gap between the last frame before it and the first after.
  const gaps = []
  for (let i = 1; i < recs.length; i++) if (recs[i].w !== recs[i - 1].w || recs[i].path !== recs[i - 1].path)
    gaps.push(`${recs[i - 1].path} ${recs[i - 1].w}x${recs[i - 1].h}→${recs[i].path} ${recs[i].w}x${recs[i].h} ${((recs[i].tDrawn - recs[i - 1].tDrawn) / 1000).toFixed(0)} ms`)
  const u = j.unity ?? {}
  const editorCores = u.editorCpuMs && u.wallMs ? (100 * u.editorCpuMs / u.wallMs).toFixed(0) : '—'
  const s = { e2e: stat(e2e), toMain: stat(toMain), mainToDrawn: stat(mainToDrawn) }
  details[j.label] = { matched, of: recs.length, ...s, gaps, validation: j.renderer.validation, counters: j.counters, fallbacks: j.fallbacks, handles: j.handles, device: u.deviceVersion, warnings: u.warnings, error: u.error, screen: u.screen }
  const checks = j.renderer.validation.checked ? `${j.renderer.validation.ok}/${j.renderer.validation.checked}` : `${matched}/${recs.length}`
  rows.push(`| ${j.label} | ${paths} | ${j.W}×${j.H} | ${j.renderer.fpsShown.toFixed(1)} | ${s.e2e?.p50} / ${s.e2e?.p95} | ${s.toMain?.p50 ?? '—'} | ${pct(j.cpuShareOfAllCores?.browser)} / ${pct(j.cpuShareOfAllCores?.gpu)} / ${pct(j.cpuShareOfAllCores?.renderer)} / ${editorCores} | ${j.counters.audio} | ${checks} | ${j.fallbacks.map(f => `${f.reason} at ${(f.atMs / 1000).toFixed(1)} s`).join(', ')} | ${gaps.join('; ')} |`)
}
console.log('| Run | Path | Size | Shown fps | End of frame→drawn ms p50 / p95 | →Genio main p50 | CPU % of one core: main / GPU / renderer / editor | Audio packets | Frame checks | Fallback | Switches |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|')
for (const r of rows) console.log(r)
console.log('\n' + JSON.stringify(details, null, 1))
