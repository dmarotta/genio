// Manual, real-editor spike. Never called by tests. No project writes.
// node scripts/play-throttle-spike.mjs <project-root> <scratch-output-dir>
// Focus Genio before running; the sampler refuses focused-Unity measurements.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
const [project, output] = process.argv.slice(2)
if (!project || !output) throw new Error('Pass project root and scratch output directory')
const cli = spawn('unity', ['shell', '--protocol', 'ndjson'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
const pending = new Map(); let id = 0
createInterface({ input: cli.stdout }).on('line', line => {
  try { const r = JSON.parse(line); const p = pending.get(r.id); if (p) { pending.delete(r.id); clearTimeout(p.timer); r.exitCode === 0 && r.envelope.success ? p.resolve(r.envelope.data.result) : p.reject(new Error(JSON.stringify(r.envelope.errors))) } } catch {}
})
cli.stderr.resume()
function call(command, args = []) {
  return new Promise((resolve, reject) => {
    const key = String(++id)
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`${command} timed out`)) }, 90000)
    pending.set(key, { resolve, reject, timer })
    cli.stdin.write(JSON.stringify({ id: key, argv: ['command', command, '--caller', 'plugin', '--skill', 'unity-cli', '--project-path', project, '--timeout', '60', ...args] }) + '\n')
  })
}
const evaluate = async code => { const r = await call('eval', [code]); if (!r.success) throw new Error(JSON.stringify(r)); return r.result }
const sampleCode = 'return new { frame = UnityEngine.Time.frameCount, time = UnityEngine.Time.realtimeSinceStartupAsDouble, focused = UnityEditorInternal.InternalEditorUtility.isApplicationActive, playing = UnityEditor.EditorApplication.isPlaying };'
let original; let entered = false; const report = { project, started: new Date().toISOString(), runs: [] }
try {
  const scenes = await call('list_open_scenes')
  if (scenes.scenes.some(s => s.isDirty || !s.path)) throw new Error('DIRTY SCENE: refusing spike')
  original = await evaluate('var t = typeof(UnityEditor.EditorApplication).Assembly; var a = System.AppDomain.CurrentDomain.GetAssemblies().First(x => x.GetName().Name == "Unity.Pipeline.Editor").GetType("Unity.Pipeline.Editor.Commands.AutoTickCommand"); return new { enabled = a.GetProperty("IsEnabled", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic).GetValue(null), interval = a.GetProperty("CurrentIntervalMs", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic).GetValue(null), playing = UnityEditor.EditorApplication.isPlaying };')
  if (original.playing) throw new Error('Editor already playing; refusing to change its session')
  report.original = original
  entered = true
  await call('editor_play')
  await new Promise(r => setTimeout(r, 8000))
  for (const interval of [16, 0]) {
    await call('set_autotick', ['--enable', 'true', '--interval_ms', String(interval), '--persist', 'false'])
    const start = await evaluate(sampleCode); const samples = []; const begin = performance.now()
    if (start.focused || !start.playing) throw new Error('Focus Genio; Unity must be playing and unfocused')
    while (performance.now() - begin < 60000) {
      const before = performance.now()
      const frame = await call('capture_game_view', ['--width', '1280', '--height', '720', '--source', 'screen'])
      const latencyMs = performance.now() - before
      const sample = await evaluate(sampleCode)
      if (sample.focused || !sample.playing) { report.interruptedSample = sample; report.partialSamples = samples; throw new Error('Focus/play state changed during spike') }
      samples.push({ ...sample, latencyMs, bytes: frame.bytes })
      if (samples.length === 1) fs.writeFileSync(path.join(output, `spike-${interval}ms.png`), Buffer.from(frame.base64, 'base64'))
      await new Promise(r => setTimeout(r, Math.max(0, 1000 - (performance.now() - before))))
    }
    const last = samples.at(-1); const sorted = samples.map(s => s.latencyMs).sort((a,b) => a-b)
    const run = { interval, seconds: last.time - start.time, frames: last.frame-start.frame, fps: (last.frame-start.frame)/(last.time-start.time), captures: samples.length, latencyMeanMs: sorted.reduce((a,b)=>a+b,0)/sorted.length, latencyP95Ms: sorted[Math.floor(sorted.length*.95)], allUnfocused: samples.every(s=>!s.focused), samples }
    report.runs.push(run); console.log(JSON.stringify({ ...run, samples: undefined }))
  }
} catch (e) { report.error = String(e); process.exitCode = 1 }
finally {
  try { if (entered) { await call('editor_stop'); await new Promise(r=>setTimeout(r,4000)) } if (original) await call('set_autotick', ['--enable', String(original.enabled), '--interval_ms', String(original.interval), '--persist', 'false']); report.finalScenes = await call('list_open_scenes'); report.restored = true } catch(e) { report.restoreError = String(e); process.exitCode=1 }
  fs.writeFileSync(path.join(output, 'spike-result.json'), JSON.stringify(report,null,2))
  cli.stdin.end(JSON.stringify({type:'shutdown'})+'\n')
  console.log(JSON.stringify({ restored: report.restored, error: report.error, restoreError: report.restoreError }))
}
