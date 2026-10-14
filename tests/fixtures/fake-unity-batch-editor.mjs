// Stand-in for a raw Unity.exe in batch mode (genio-unity's fallback). It
// writes what the flags ask for and records its argv in FAKE_UNITY_CALLS.
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const value = name => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1] }
if (process.env.FAKE_UNITY_CALLS) fs.appendFileSync(process.env.FAKE_UNITY_CALLS, JSON.stringify({ editor: true, argv }) + '\n')
const log = value('-logFile')
if (log) fs.writeFileSync(log, 'Batch editor log\n')
if (argv.includes('-runTests')) {
  const scenario = process.env.FAKE_UNITY_TESTS ?? 'pass'
  const failed = scenario === 'fail' ? 1 : 0, total = scenario === 'none' ? 0 : 2
  const cases = total ? `<test-case name="Jumps" fullname="Game.Tests.Jumps" result="Passed" duration="0.1"/><test-case name="Lands" fullname="Game.Tests.Lands" result="${failed ? 'Failed' : 'Passed'}" duration="0.2">${failed ? '<failure><message><![CDATA[fell through]]></message></failure>' : ''}</test-case>` : ''
  fs.writeFileSync(value('-testResults'), `<?xml version="1.0"?><test-run total="${total}" passed="${total - failed}" failed="${failed}" skipped="0" inconclusive="0" result="${failed ? 'Failed' : 'Passed'}">${cases}</test-run>`)
  // Like Unity's -runTests: 2 on failures, 0 otherwise, even when nothing ran.
  process.exit(failed ? 2 : 0)
}
const player = value('-buildWindows64Player') ?? value('-buildLinux64Player')
if (player) { fs.mkdirSync(path.dirname(player), { recursive: true }); fs.writeFileSync(player, 'player') }
process.exit(0)
