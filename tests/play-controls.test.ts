import { expect, it } from 'vitest'
import { controls } from '../src/shared/play-controls'
import type { PlayerState } from '../src/shared/play'

// Recon appendix B2, one row per service state: [Unity label, action, enabled], [Play label, action, enabled], pause/step enabled.
const TABLE: Record<PlayerState, [[string, string, boolean], [string, string, boolean], boolean]> = {
  idle: [['Start Unity', 'start', true], ['Enter Play', 'enter', true], false],
  crashed: [['Start Unity', 'start', true], ['Enter Play', 'enter', true], false],
  error: [['Start Unity', 'start', true], ['Enter Play', 'enter', true], false],
  'missing-editor': [['Start Unity', 'start', true], ['Enter Play', 'enter', true], false],
  'low-memory': [['Start anyway', 'start-anyway', true], ['Enter Play', 'enter-anyway', true], false],
  'limit-reached': [['Start Unity', 'start', false], ['Enter Play', 'enter', false], false],
  copying: [['Cancel', 'cancel', true], ['Enter Play', 'enter', false], false],
  starting: [['Cancel', 'cancel', true], ['Enter Play', 'enter', false], false],
  ready: [['Stop Unity', 'stop', true], ['Enter Play', 'enter', true], false],
  syncing: [['Stop Unity', 'stop', true], ['Exit Play', 'exit', true], false],
  'entering-play': [['Stop Unity', 'stop', true], ['Exit Play', 'exit', true], false],
  playing: [['Stop Unity', 'stop', true], ['Exit Play', 'exit', true], true],
  paused: [['Stop Unity', 'stop', true], ['Exit Play', 'exit', true], true],
  'exiting-play': [['Stop Unity', 'stop', false], ['Exit Play', 'exit', false], false],
  'shutting-down': [['Stopping…', 'stop', false], ['Enter Play', 'enter', false], false],
  'compile-errors': [['Stop Unity', 'stop', true], ['Enter Play', 'enter', true], false],
  'stuck-dialog': [['Restart Unity', 'restart', true], ['Enter Play', 'enter', false], false],
  'close-stuck': [['Close again', 'close-again', true], ['Enter Play', 'enter', false], false]
}

it.each(Object.entries(TABLE) as [PlayerState, (typeof TABLE)[PlayerState]][])('%s', (state, [unity, play, live]) => {
  const c = controls(state)
  expect([c.unity.label, c.unity.action, c.unity.enabled]).toEqual(unity)
  expect([c.play.label, c.play.action, c.play.enabled]).toEqual(play)
  expect([c.pause.enabled, c.step.enabled]).toEqual([live, live])
  expect(c.pause.action).toBe('pause'); expect(c.step.action).toBe('step')
})
it('marks ■ active while Play runs, ‖ pressed while paused, and Start anyway amber', () => {
  expect(controls('playing').play.active).toBe(true); expect(controls('ready').play.active).toBeUndefined()
  expect(controls('paused').pause).toMatchObject({ active: true, label: 'Resume' }); expect(controls('playing').pause).toMatchObject({ label: 'Pause' })
  expect(controls('low-memory').unity.warn).toBe(true); expect(controls('idle').unity.warn).toBeUndefined()
})
it('offers no Start anyway when Windows cannot commit the estimate', () => {
  const c = controls('low-memory', { hard: true })
  expect([c.unity.label, c.unity.action, c.unity.warn]).toEqual(['Start Unity', 'start', undefined]); expect(c.play.action).toBe('enter')
})
it('treats an unknown state as Off and holds the scene dropdown during transitions', () => {
  expect(controls(undefined)).toEqual(controls('idle'))
  expect(controls('copying').scene.enabled).toBe(false); expect(controls('playing').scene.enabled).toBe(true)
  expect(controls('idle').resolution.enabled).toBe(true); expect(controls('close-stuck').resolution.enabled).toBe(false)
})
