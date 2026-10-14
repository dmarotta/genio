import fs from 'node:fs'
import path from 'node:path'
import type { UnityUnitConfig } from './unity-unit'
import { isSubPath, run, writeJson } from './util'

export interface UnityGateResult {
  outcome: 'passed' | 'findings' | 'infra'
  code: number
  output: string
}

/** Fail closed on missing/malformed counters; skipped test cases did not execute. */
function nunitTotals(xml: string): { ran: number; skipped: number; failed: number } | undefined {
  const head = /<test-run\b([^>]*)>/.exec(xml)?.[1]
  if (!head || !/<\/test-run\s*>/.test(xml)) return undefined
  const count = (key: string): number => {
    const raw = new RegExp(`\\s${key}="([^\"]*)"`).exec(head)?.[1]
    return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN
  }
  const total = count('total'), passed = count('passed'), failed = count('failed'), skipped = count('skipped')
  const inconclusive = /\sinconclusive=/.test(head) ? count('inconclusive') : 0
  if (![total, passed, failed, skipped, inconclusive].every(n => Number.isSafeInteger(n) && n >= 0) ||
      total !== passed + failed + skipped + inconclusive) return undefined
  const failure = /\sresult="Failed(?:\([^"]*\))?"/.test(head) || /<test-case\b[^>]*\sresult="Failed"/.test(xml)
  return { ran: total - skipped, skipped, failed: Math.max(failed, failure ? 1 : 0) }
}

/** The wrapper owns Library seeding, deadlines and the shared editor seat. */
export async function runUnityGate(config: UnityUnitConfig, script: string, configFile: string, timeoutMs: number): Promise<UnityGateResult> {
  writeJson(configFile, config)
  const seconds = Math.max(1, Math.floor(timeoutMs / 1000))
  const r = await run(process.execPath, [script, 'test', '--mode', 'EditMode', '--timeout', String(seconds), '--wait', String(seconds)], {
    cwd: config.worktree,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', GENIO_UNITY_CONFIG: configFile },
    // Seeding may take a long time. The wrapper enforces seat/editor deadlines;
    // killing only its process here could orphan an editor and free its seat.
    timeoutMs: 0
  })
  let record: { schema?: string; verb?: string; task?: string; dir?: string; exitCode?: number; reports?: { nunit?: string }; message?: string; target?: { path?: string; kind?: string } } | undefined
  try { record = JSON.parse(r.stdout) } catch { /* a failed launch has no record */ }
  const tail = (r.stdout + '\n' + r.stderr).trim().split(/\r?\n/).slice(-80).join('\n')
  const result = (outcome: UnityGateResult['outcome'], detail: string): UnityGateResult => ({ outcome, code: r.code, output: `${detail}\n${tail}`.trim() })
  if (record?.schema !== 'genio.unity-run.v1' || record.verb !== 'test' || record.task !== config.task || record.exitCode !== r.code ||
      record.target?.kind !== 'copy' || typeof record.target.path !== 'string' ||
      path.relative(path.resolve(config.worktree, config.engineRoot), record.target.path) !== '' ||
      !record.dir || !isSubPath(record.dir, config.runs) || path.resolve(record.dir) === path.resolve(config.runs)) {
    return result('infra', 'The Unity wrapper did not return a valid test run record for this worktree.')
  }
  // Test failures belong to the unit; launch, compilation and service failures need recovery.
  if (r.code === 8) return result('findings', 'Unity tests failed (exit 8).')
  if (r.code !== 0) return result('infra', `Unity test infrastructure failed (exit ${r.code}): ${record.message ?? 'see the run record and editor log'}`)
  const report = record.reports?.nunit
  if (!report || path.resolve(report) !== path.join(path.resolve(record.dir), 'results.xml')) return result('infra', 'Unity exited 0 without an NUnit report for this run.')
  let xml: string
  try { xml = fs.readFileSync(report, 'utf8') } catch { return result('infra', `The NUnit report is unreadable: ${report}`) }
  const tests = nunitTotals(xml)
  if (!tests) return result('infra', `The NUnit report has no valid test totals: ${report}`)
  if (tests.failed > 0) return result('findings', `NUnit reports failed tests despite exit 0 (${tests.failed} failed). Report: ${report}`)
  if (tests.ran <= 0) return result('findings', `No Unity tests ran (${tests.skipped} skipped). Add or enable tests for the change. Report: ${report}`)
  return result('passed', `NUnit: ${tests.ran} tests ran, none failed (${tests.skipped} skipped). Report: ${report}`)
}
