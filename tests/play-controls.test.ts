import { expect, it } from 'vitest'
import { controls, look, soundLook } from '../src/shared/play-controls'
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
// Every state's toolbar: [Unity, ▶, ‖, ⏭] class names, then aria-pressed of ▶ and ‖ (⏭ and Unity are not toggles).
const LOOKS: Record<PlayerState, [string[], [boolean, boolean]]> = {
  idle: [['plain is-ready', 'volt is-ready', 'amber is-off', 'plain is-off'], [false, false]],
  crashed: [['plain is-ready', 'volt is-ready', 'amber is-off', 'plain is-off'], [false, false]],
  error: [['plain is-ready', 'volt is-ready', 'amber is-off', 'plain is-off'], [false, false]],
  'missing-editor': [['plain is-ready', 'volt is-ready', 'amber is-off', 'plain is-off'], [false, false]],
  'low-memory': [['amber is-ready', 'amber is-ready', 'amber is-off', 'plain is-off'], [false, false]],
  'limit-reached': [['plain is-off', 'volt is-off', 'amber is-off', 'plain is-off'], [false, false]],
  copying: [['plain is-ready', 'volt is-off', 'amber is-off', 'plain is-off'], [false, false]],
  starting: [['plain is-ready', 'volt is-off', 'amber is-off', 'plain is-off'], [false, false]],
  ready: [['plain is-ready', 'volt is-ready', 'amber is-off', 'plain is-off'], [false, false]],
  syncing: [['plain is-ready', 'volt is-on', 'amber is-off', 'plain is-off'], [true, false]],
  'entering-play': [['plain is-ready', 'volt is-on', 'amber is-off', 'plain is-off'], [true, false]],
  playing: [['plain is-ready', 'volt is-on', 'amber is-ready', 'plain is-ready'], [true, false]],
  paused: [['plain is-ready', 'volt is-on', 'amber is-on', 'plain is-ready'], [true, true]],
  'exiting-play': [['plain is-off', 'volt is-on', 'amber is-off', 'plain is-off'], [true, false]],
  'shutting-down': [['plain is-off', 'volt is-off', 'amber is-off', 'plain is-off'], [false, false]],
  'compile-errors': [['plain is-ready', 'volt is-ready', 'amber is-off', 'plain is-off'], [false, false]],
  'stuck-dialog': [['plain is-ready', 'volt is-off', 'amber is-off', 'plain is-off'], [false, false]],
  'close-stuck': [['plain is-ready', 'volt is-off', 'amber is-off', 'plain is-off'], [false, false]]
}
it.each(Object.entries(LOOKS) as [PlayerState, (typeof LOOKS)[PlayerState]][])('%s looks', (state, [classes, pressed]) => {
  const c = controls(state)
  const l = [look('unity', c.unity), look('play', c.play), look('pause', c.pause), look('step', c.step)]
  expect(l.map(x => x.className)).toEqual(classes)
  expect([l[1].pressed, l[2].pressed]).toEqual(pressed)
  expect(l[0].pressed).toBeUndefined(); expect(l[3].pressed).toBeUndefined()
  // Off always says why; ready and on never do.
  for (const x of l) expect(x.title.includes(' · ')).toBe(x.className.endsWith('is-off'))
})
it('titles carry the shortcut and the reason a button is off', () => {
  expect(look('play', controls('ready').play).title).toBe('Enter Play (Ctrl+P)')
  expect(look('play', controls('playing').play).title).toBe('Exit Play (Ctrl+P)')
  expect(look('pause', controls('paused').pause).title).toBe('Resume (Ctrl+Shift+P)')
  expect(look('step', controls('idle').step).title).toBe('Step one frame (Ctrl+Alt+P) · Only while playing')
  expect(look('play', controls('starting').play).title).toBe('Enter Play (Ctrl+P) · Unity is starting')
  expect(look('unity', controls('limit-reached').unity).title).toBe('Start Unity · The editor limit is reached')
})
it('a press in flight turns a ready button off, never an on one', () => {
  expect(look('pause', controls('playing').pause, false)).toMatchObject({ className: 'amber is-off', title: 'Pause (Ctrl+Shift+P) · Wait for the last press to finish' })
  expect(look('play', controls('idle').play, false, 'Choose a source first').title).toBe('Enter Play (Ctrl+P) · Choose a source first')
  expect(look('pause', controls('paused').pause, false)).toMatchObject({ className: 'amber is-on', pressed: true })
})
it('marks ▶ active while Play runs, ‖ pressed while paused, and Start anyway amber', () => {
  expect(controls('playing').play.active).toBe(true); expect(controls('ready').play.active).toBeUndefined()
  expect(controls('paused').pause).toMatchObject({ active: true, label: 'Resume' }); expect(controls('playing').pause).toMatchObject({ label: 'Pause' })
  expect(controls('low-memory').unity.warn).toBe(true); expect(controls('idle').unity.warn).toBeUndefined()
})
it('draws the game sound toggle ready while sound plays and on (filled, pressed) while muted, never off', () => {
  expect(soundLook(false)).toEqual({ className: 'plain is-ready', title: 'Mute game sound', pressed: false })
  expect(soundLook(true)).toEqual({ className: 'plain is-on', title: 'Unmute game sound', pressed: true })
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
