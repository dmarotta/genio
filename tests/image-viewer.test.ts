import { describe, expect, it } from 'vitest'
import { fitImage, viewerClick, viewerKey } from '../src/renderer/src/lib/image-viewer'

/** A stand-in for a DOM element whose ancestors carry the given classes. */
const el = (...classes: string[]) => ({
  closest: (sel: string) => (sel.split(',').some((s) => classes.includes(s.trim().slice(1))) ? {} : null)
})

describe('image viewer open/close', () => {
  it('closes on a backdrop click', () => {
    expect(viewerClick(el('image-viewer'))).toEqual({ type: 'close' })
  })
  it('closes on the × button', () => {
    expect(viewerClick(el('image-viewer-close', 'image-viewer'))).toEqual({ type: 'close' })
  })
  it('does not close when the image itself is clicked', () => {
    expect(viewerClick(el('image-viewer-img', 'image-viewer'))).toEqual({ type: 'none' })
  })
  it('does not close on the prev/next arrows', () => {
    expect(viewerClick(el('image-viewer-nav', 'image-viewer'))).toEqual({ type: 'none' })
  })
  it('closes on Esc', () => {
    expect(viewerKey('Escape', 0, 1)).toEqual({ type: 'close' })
  })
  it('arrow keys cycle between several images and do nothing for one', () => {
    expect(viewerKey('ArrowRight', 2, 3)).toEqual({ type: 'show', index: 0 })
    expect(viewerKey('ArrowLeft', 0, 3)).toEqual({ type: 'show', index: 2 })
    expect(viewerKey('ArrowRight', 0, 1)).toEqual({ type: 'none' })
    expect(viewerKey('a', 0, 3)).toEqual({ type: 'none' })
  })
})

describe('fitImage', () => {
  it('shrinks a large image to 95% of the viewport keeping aspect ratio', () => {
    expect(fitImage(4000, 2000, 1000, 1000)).toEqual({ width: 950, height: 475 })
  })
  it('does not upscale a mid-size image', () => {
    expect(fitImage(600, 500, 1000, 1000)).toEqual({ width: 600, height: 500 })
  })
  it('modestly upscales a small image', () => {
    expect(fitImage(200, 100, 1000, 1000)).toEqual({ width: 300, height: 150 })
  })
})
