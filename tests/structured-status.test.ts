import { expect, it } from 'vitest'
import { parseStatusLine, foldOpenDecisions } from '../src/main/status'
import { renderBrief, type BriefInput } from '../src/main/brief'

it('parses short questions and exact answers while keeping diagnostics separate', () => {
  const metadata = { options: ['Close my test scene', 'Keep it'], recommendation: 'Close my test scene', details: 'PID 123; C:/test; command: check --scene', batch: 'scene-checks' }
  const e = parseStatusLine(`needs-decision [key=scene]: May I close my test scene? || ${JSON.stringify(metadata)}`, 'unit')
  expect(e.text).toBe('May I close my test scene?')
  expect(e.key).toBe('scene')
  expect(JSON.parse(e.fields.choice)).toEqual({ options: metadata.options, recommendation: metadata.recommendation, context: metadata.details, batch: metadata.batch })
  expect(foldOpenDecisions([e]).get('scene')).toBe(e)
})

it('preserves legacy and malformed status text without inventing options', () => {
  for (const text of ['Which scene?', 'Which scene? || invalid', 'Which scene? || {"options":"yes"}', 'Which scene? || {"recommendation":42}']) {
    const e = parseStatusLine(`blocked [key=scene]: ${text}`, 'unit')
    expect(e.text).toBe(text)
    expect(e.fields.choice).toBeUndefined()
  }
})

it('ships a parseable authoring example and instructs units to keep clarification open', () => {
  const brief = renderBrief({ kind: 'ship', project: 'test', taskId: 'unit', worktree: 'C:/test', branch: 'build', baseBranch: 'main', intent: 'Test', statusFile: 'C:/status', inboxDir: 'C:/inbox', taskDataDir: 'C:/data' } as BriefInput)
  const line = brief.split('\n').find(l => l.startsWith('needs-decision [key=scene]:'))!
  expect(JSON.parse(parseStatusLine(line, 'unit').fields.choice).options).toHaveLength(2)
  expect(brief).toContain('never append resolved or start the proposed action on clarification alone')
})
