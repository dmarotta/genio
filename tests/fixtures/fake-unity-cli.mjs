// Stand-in for Unity's `unity` CLI: never starts an editor. Every call is
// appended to FAKE_UNITY_CALLS; FAKE_UNITY_* variables pick the outcome.
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const env = process.env
const flag = name => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1] }
const after = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : []
const editorFlag = name => { const i = after.indexOf(name); return i < 0 ? undefined : after[i + 1] }
const project = ['test', 'run', 'build'].includes(argv[0]) ? argv[1] : flag('--project-path')
if (env.FAKE_UNITY_CALLS) fs.appendFileSync(env.FAKE_UNITY_CALLS, JSON.stringify({ argv, seeded: project ? fs.existsSync(path.join(project, 'Library', 'warm')) : undefined, credentials: project ? fs.existsSync(path.join(project, 'Library', 'Pipeline')) : undefined }) + '\n')
const json = (code, data, errors = []) => { process.stdout.write(JSON.stringify({ success: code === 0, command: argv[0], data, errors, warnings: [] }, null, 2) + '\n'); process.exit(code) }

const NUNIT = {
  pass: '<?xml version="1.0"?><test-run id="2" testcasecount="2" result="Passed" total="2" passed="2" failed="0" inconclusive="0" skipped="0"><test-suite><test-case id="1" name="Jumps" fullname="Game.Tests.Jumps" result="Passed" duration="0.1"/><test-case id="2" name="Lands" fullname="Game.Tests.Lands" result="Passed" duration="0.2"/></test-suite></test-run>',
  fail: '<?xml version="1.0"?><test-run id="2" testcasecount="2" result="Failed(Child)" total="2" passed="1" failed="1" inconclusive="0" skipped="0"><test-suite><test-case id="1" name="Jumps" fullname="Game.Tests.Jumps" result="Passed" duration="0.1"/><test-case id="2" name="DoubleJump" fullname="Game.Tests.DoubleJump" result="Failed" duration="0.3"><failure><message><![CDATA[Expected 2 jumps & got 1]]></message></failure></test-case></test-suite></test-run>',
  none: '<?xml version="1.0"?><test-run id="2" testcasecount="0" result="Passed" total="0" passed="0" failed="0" inconclusive="0" skipped="0"></test-run>'
}

switch (argv[0]) {
  case '--version': process.stdout.write(`${env.FAKE_UNITY_VERSION ?? '1.0.0-beta.13'}\n`); process.exit(0)
  case 'license':
    if (env.FAKE_UNITY_LICENSE === 'none') json(4, null, [{ code: 'NO_LICENSE', message: 'No active license' }])
    json(0, { active: env.FAKE_UNITY_LICENSE !== 'inactive', signedIn: true, licenses: [{ product: 'Unity Personal' }], machineId: 'secret-machine' })
  case 'test': {
    const scenario = env.FAKE_UNITY_TESTS ?? 'pass'
    fs.writeFileSync(editorFlag('-logFile'), `Running tests in ${project}\n`)
    fs.writeFileSync(flag('--output'), NUNIT[scenario])
    fs.writeFileSync(flag('--junit-output'), '<testsuites/>')
    json(scenario === 'fail' ? 8 : 0, { total: scenario === 'pass' ? 2 : scenario === 'fail' ? 2 : 0 })
  }
  case 'run': {
    const broken = env.FAKE_UNITY_COMPILE === 'error'
    fs.writeFileSync(editorFlag('-logFile'), broken ? 'Assets/Player.cs(4,9): error CS0103: The name \'jumpz\' does not exist\nAssets/Player.cs(4,9): error CS0103: The name \'jumpz\' does not exist\n' : 'Import done\n')
    process.exit(broken ? 1 : 0)
  }
  case 'build': {
    const out = flag('--output-path')
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, 'player')
    fs.writeFileSync(flag('--log-file'), 'Build succeeded\n')
    process.stdout.write('{"type":"progress","command":"build","message":"Starting Unity..."}\n')
    json(0, { target: flag('--target'), output: out })
  }
  case 'recompile': json(env.FAKE_UNITY_COMPILE === 'error' ? 6 : 0, { project, errors: [] })
  case 'status': json(0, [{ project, state: 'ready' }])
  default: process.stderr.write(`fake unity: unexpected ${argv.join(' ')}\n`); process.exit(2)
}
