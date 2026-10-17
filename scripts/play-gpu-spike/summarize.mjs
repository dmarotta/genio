// Builds the spike's results table from <results>/*.json (one per consumer run, with the editor's side inside).
// Latency is from Unity's end of frame (t0, logged per frame number by SpikeScene) to the renderer's drawImage:
// the GPU path carries t0 in its 'GF' message; the JPEG path's frame number is read back from the drawn image.
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
  const e2e = [], raf = [], unityToMain = []
  let matched = 0
  for (const r of recs) {
    const start = j.mode === 'gpu' ? r.t0 : t0.get(r.frame)
    if (start === undefined) continue
    matched++
    e2e.push((r.tDrawn - start) / 1000); if (r.tRaf) raf.push((r.tRaf - start) / 1000); unityToMain.push((r.tMain - start) / 1000)
  }
  // Resize: the gap between the last frame drawn at the old size and the first at the new one.
  let resize
  for (let i = 1; i < recs.length; i++) if (recs[i].w !== recs[i - 1].w) { resize = { from: `${recs[i - 1].w}x${recs[i - 1].h}`, to: `${recs[i].w}x${recs[i].h}`, gapMs: +((recs[i].tDrawn - recs[i - 1].tDrawn) / 1000).toFixed(1) }; break }
  const u = j.unity ?? {}, g = u.gpu ?? {}
  const editorCores = u.editorCpuMs && u.wallMs ? (100 * u.editorCpuMs / u.wallMs).toFixed(0) : '—'
  const s = { e2e: stat(e2e), raf: stat(raf), unityToMain: stat(unityToMain) }
  if (j.mode === 'gpu') Object.assign(s, {
    t0ToGpuDone: stat(recs.map(r => (r.tReady - r.t0) / 1000)), gpuDoneToMain: stat(recs.map(r => (r.tMain - r.tReady) / 1000)),
    import: stat(recs.map(r => (r.tImported - r.tMain) / 1000)), mainToRenderer: stat(recs.map(r => (r.tRecv - r.tImported) / 1000)), draw: stat(recs.map(r => (r.tDrawn - r.tRecv) / 1000))
  })
  else Object.assign(s, { mainToRenderer: stat(recs.map(r => (r.tRecv - r.tMain) / 1000)), decodeDraw: stat(recs.map(r => (r.tDrawn - r.tRecv) / 1000)) })
  details[j.label] = { matched, of: recs.length, ...s, gpu: g, resize, validation: j.renderer.validation, counters: j.counters, handles: j.handles, device: u.deviceVersion, renderThread: u.renderThread, error: u.error, sessionError: u.sessionError, screen: u.screen, rings: j.rings?.map(r => `${r.gen}:${r.w}x${r.h}`) }
  rows.push(`| ${j.label} | ${j.mode} | ${j.W}×${j.H}@${j.fps} | ${j.renderer.fpsShown.toFixed(1)} | ${s.e2e?.p50} / ${s.e2e?.p95} | ${s.raf?.p50} / ${s.raf?.p95} | ${s.unityToMain?.p50} | ${j.mode === 'gpu' ? `${g.captureBlitMsAvg} / ${g.copySignalFlushMsAvg} / ${g.submitToGpuDoneMsAvg}` : '—'} | ${pct(j.cpuShareOfAllCores?.browser)} / ${pct(j.cpuShareOfAllCores?.gpu)} / ${pct(j.cpuShareOfAllCores?.renderer)} / ${editorCores} | ${j.mode === 'gpu' ? `${j.renderer.validation.ok}/${j.renderer.validation.checked}` : `${matched}/${recs.length}`} | ${resize ? `${resize.from}→${resize.to} ${resize.gapMs} ms` : ''} |`)
}
console.log('| Run | Path | Size@fps | Shown fps | End of frame→drawn ms p50 / p95 | →next display frame p50 / p95 | →Genio main p50 | Unity ms per frame: capture+blit / copy+signal+flush / GPU done | CPU % of one core: main / GPU / renderer / editor | Frame checks | Resize |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|')
for (const r of rows) console.log(r)
console.log('\n' + JSON.stringify(details, null, 1))
