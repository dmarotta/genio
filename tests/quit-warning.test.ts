import { describe, expect, it } from 'vitest'
import { stopUnitsDialog, unitsInPlay } from '../src/main/usage-policy'
import type { Task, TaskState } from '../src/shared/types'

const unit = (state: TaskState, project = 'world'): Task => ({ id: state, title: `${state} unit`, state, project, terminalId: state } as Task)
const homes = (tasks: Task[]) => [{ crew: { list: () => tasks } }]

describe('units the quit and close warning counts', () => {
  it.each<[TaskState, boolean, boolean]>([
    ['spawning', false, true],
    ['working', true, true],
    ['validating', true, true],
    ['paused', true, true],
    ['blocked', true, true],
    ['needs-decision', true, true],
    ['stale', true, true],
    ['working', false, false],
    ['paused', false, false],
    ['done', true, false],
    ['ready', true, false],
    ['merged', true, false],
    ['failed', true, false],
    ['exited', true, false],
    ['detached', true, false],
    ['cleaned', true, false]
  ])('%s with a live terminal=%s counts: %s', (state, alive, counted) => {
    expect(unitsInPlay(homes([unit(state)]), () => alive)).toHaveLength(counted ? 1 : 0)
  })

  it('ignores two finished Recons idling at their prompt', () => {
    expect(unitsInPlay(homes([unit('done'), { ...unit('done'), id: 'other' }]), () => true)).toEqual([])
  })

  it('narrows to one project', () => {
    const tasks = [unit('working', 'world'), unit('validating', 'other')]
    expect(unitsInPlay(homes(tasks), () => true, 'world').map(t => t.project)).toEqual(['world'])
    expect(unitsInPlay(homes(tasks), () => true)).toHaveLength(2)
  })
})

describe('the stop-units dialog', () => {
  it('names each running unit and what stopping keeps', () => {
    const d = stopUnitsDialog([{ title: 'Fix lighting', state: 'working' }, { title: 'Scout audio', state: 'blocked' }], 'exit')
    expect(d.message).toBe('2 units are still running.')
    expect(d.buttons[0]).toBe('Stop units and exit')
    expect(d.detail).toContain('• Fix lighting (working)\n• Scout audio (blocked)')
    expect(d.detail).toContain('Exiting Genio stops their terminals; worktrees are kept for respawn.')
  })

  it('uses the singular and the close wording', () => {
    const d = stopUnitsDialog([{ title: 'Fix lighting', state: 'spawning' }], 'close')
    expect(d.message).toBe('1 unit is still running.')
    expect(d.detail).toMatch(/^• Fix lighting \(spawning\)\n\nClosing stops/)
  })

  it('summarises a long list', () => {
    const d = stopUnitsDialog(Array.from({ length: 11 }, (_, i) => ({ title: `Unit ${i}`, state: 'working' as const })), 'exit')
    expect(d.detail).toContain('• Unit 7 (working)\n• and 3 more')
    expect(d.detail).not.toContain('Unit 8')
  })
})
