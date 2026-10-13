import { describe, expect, it } from 'vitest'
import { isChatPopoutUrl, visiblePopoutBounds } from '../src/shared/chat-popout'

describe('chat pop-out URL', () => {
  it('accepts only the owner page with the chat hash', () => {
    const owner = 'file:///C:/Genio/out/renderer/index.html?project=one&wksp=ally-one'
    expect(isChatPopoutUrl(owner + '#genio-chat-panel', owner)).toBe(true)
    expect(isChatPopoutUrl(owner.replace('project=one', 'project=two') + '#genio-chat-panel', owner)).toBe(false)
    expect(isChatPopoutUrl('https://example.com/#genio-chat-panel', owner)).toBe(false)
  })
})

describe('remembered pop-out bounds across monitors', () => {
  const left = { x: 0, y: 0, width: 1920, height: 1040 }
  const right = { x: 1920, y: 0, width: 1280, height: 984 }
  it('reopens where it was on any current display, fully inside that work area', () => {
    expect(visiblePopoutBounds({ x: 2000, y: 100, width: 500, height: 600 }, [left, right])).toEqual({ x: 2000, y: 100, width: 500, height: 600 })
    // Straddling the seam: kept on the display that shows most of the title bar, pulled fully inside it.
    expect(visiblePopoutBounds({ x: 1800, y: 900, width: 500, height: 600 }, [left, right])).toEqual({ x: 1920, y: 384, width: 500, height: 600 })
    expect(visiblePopoutBounds({ x: 1500, y: 900, width: 500, height: 600 }, [left, right])).toEqual({ x: 1420, y: 440, width: 500, height: 600 })
  })
  it('lets the OS place it when its monitor is gone, and shrinks it to a smaller display', () => {
    expect(visiblePopoutBounds({ x: 2000, y: 100, width: 500, height: 600 }, [left])).toBeUndefined()
    expect(visiblePopoutBounds(undefined, [left])).toBeUndefined()
    expect(visiblePopoutBounds({ x: NaN, y: 0, width: 500, height: 600 }, [left])).toBeUndefined()
    expect(visiblePopoutBounds({ x: 1950, y: 10, width: 2000, height: 2000 }, [right])).toEqual({ x: 1920, y: 0, width: 1280, height: 984 })
    expect(visiblePopoutBounds({ x: 10, y: 10, width: 100, height: 100 }, [left])).toMatchObject({ width: 360, height: 360 })
  })
})
