// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { handleEvent } from '../src/renderer/src/store'
import { speak, stopSpeaking } from '../src/renderer/src/lib/voice'

vi.mock('../src/renderer/src/lib/voice', () => ({ speak: vi.fn(), stopSpeaking: vi.fn(), onVoiceOffer: vi.fn(() => () => undefined) }))

it('a message sent to the chat stops Genio speaking at once, as the mic and Esc do', () => {
  handleEvent({ type: 'speak-stop', workspace: 'main' })
  expect(stopSpeaking).toHaveBeenCalledOnce()
  expect(speak).not.toHaveBeenCalled()
})
