// Manual integration test against a disposable Unity project, never a real world.
// node --experimental-transform-types scripts/play-stream-smoke.mjs <scratch-project> <output>
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { PlayStream } from '../src/main/play-stream.ts'
const [project, output] = process.argv.slice(2)
if (!project || path.basename(project) !== 'unity-smoke' || !output) throw new Error('Supply the disposable unity-smoke project and output directory')
const status = JSON.parse(execFileSync('unity', ['status','--project-path',project,'--format','json'], {encoding:'utf8'}))
if (!status.success) throw new Error('Smoke editor unavailable')
async function call(command, parameters = {}) {
  const d = JSON.parse(fs.readFileSync(path.join(project,'Library/Pipeline/.unity-pipeline-port'),'utf8'))
  if (path.resolve(d.projectPath).toLowerCase() !== path.resolve(project).toLowerCase()) throw new Error('Wrong editor')
  return new Promise((resolve,reject) => {
    const body=JSON.stringify({command,parameters,timeout:15000})
    const req=http.request({hostname:'127.0.0.1',port:d.port,path:'/api/exec',method:'POST',headers:{Authorization:`Bearer ${d.evalToken}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{try {const e=JSON.parse(Buffer.concat(chunks).toString());if(!e.success || e.result?.success===false) throw new Error(JSON.stringify(e));resolve(e.result)}catch(e){reject(e)}})
    });req.setTimeout(20000,()=>req.destroy());req.on('error',reject);req.end(body)
  })
}
const stream = new PlayStream(), report={project,started:new Date().toISOString(),frames:0}
try {
  await call('eval', {code:'UnityEditor.AssetDatabase.Refresh(); return 1;'})
  await new Promise(r=>setTimeout(r,4000))
  await call('eval', {code:'var scene = UnityEditor.SceneManagement.EditorSceneManager.NewScene(UnityEditor.SceneManagement.NewSceneSetup.EmptyScene); var camera = new UnityEngine.GameObject("Camera").AddComponent<UnityEngine.Camera>(); camera.transform.position = new UnityEngine.Vector3(0,0,-10); camera.clearFlags = UnityEngine.CameraClearFlags.SolidColor; camera.backgroundColor = UnityEngine.Color.red; camera.orthographic = true; camera.orthographicSize = 3; for (int i=0;i<2;i++) { var cube = UnityEngine.GameObject.CreatePrimitive(UnityEngine.PrimitiveType.Cube); cube.transform.position = new UnityEngine.Vector3(0,i==0?1:-1,0); var material = new UnityEngine.Material(UnityEngine.Shader.Find("Unlit/Color")); material.color = i==0?UnityEngine.Color.green:UnityEngine.Color.blue; cube.GetComponent<UnityEngine.Renderer>().sharedMaterial=material; } UnityEditor.SceneManagement.EditorSceneManager.SaveScene(scene,"Assets/Smoke.unity"); UnityEditor.EditorWindow.GetWindow(typeof(UnityEditor.EditorApplication).Assembly.GetType("UnityEditor.GameView")); return 1;'})
  await call('editor_play');await new Promise(r=>setTimeout(r,5000))
  const session=await stream.listen()
  stream.onFrame=frame=>{ report.frames++; if(report.frames===1) fs.writeFileSync(path.join(output,'first.jpg'),frame) }
  await call('genio_stream_start',{...session,width:640,height:360})
  await new Promise(r=>setTimeout(r,5000))
  report.connected=stream.connected
  report.running=await call('eval',{code:'return new { frame=UnityEngine.Time.frameCount, active=Genio.Play.StreamSession.Active };'})
  await call('editor_pause'); report.step=await call('genio_step')
  report.resolution=await call('genio_set_resolution',{width:800,height:600})
  report.console=await call('console',{tail:20})
  if (!report.frames) throw new Error('No JPEG frames received')
} catch(e) { report.error=String(e);process.exitCode=1 }
finally {
  stream.close()
  try { await call('editor_stop');report.stopped=true } catch(e) {report.stopError=String(e)}
  fs.writeFileSync(path.join(output,'smoke-result.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify({...report,console:undefined}))
}
