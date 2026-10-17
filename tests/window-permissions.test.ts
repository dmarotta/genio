import { describe, expect, it } from 'vitest'
import { allowPermission } from '../src/main/window-permissions'

describe('window permissions', () => {
  it("grants the microphone only to Genio's own windows, audio only, from the page itself", () => {
    expect(allowPermission('media', { own: true, isMainFrame: true, mediaTypes: ['audio'] })).toBe(true)
    expect(allowPermission('media', { own: true, isMainFrame: true, mediaTypes: ['audio', 'video'] })).toBe(false)
    expect(allowPermission('media', { own: true, isMainFrame: true, mediaTypes: ['video'] })).toBe(false)
    expect(allowPermission('media', { own: true, isMainFrame: true, mediaTypes: [] })).toBe(false)
    expect(allowPermission('media', { own: true, isMainFrame: false, mediaTypes: ['audio'] })).toBe(false)
    expect(allowPermission('media', { own: false, isMainFrame: true, mediaTypes: ['audio'] })).toBe(false)
  })
  it('keeps what the UI uses and denies everything else', () => {
    for (const p of ['clipboard-read', 'clipboard-sanitized-write', 'pointerLock', 'fullscreen']) {
      expect(allowPermission(p, { own: true, isMainFrame: true }), p).toBe(true)
      expect(allowPermission(p, { own: false, isMainFrame: true }), p).toBe(false)
    }
    for (const p of ['geolocation', 'notifications', 'display-capture', 'hid', 'usb', 'openExternal']) expect(allowPermission(p, { own: true, isMainFrame: true }), p).toBe(false)
  })
})
