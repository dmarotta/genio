import { describe, expect, it, vi } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { ToolPages } from '../src/main/tool-pages'

const result = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] })
const text = (r: CallToolResult) => r.content.map(c => c.type === 'text' ? c.text : '').join('')
const meta = (r: CallToolResult) => (r.structuredContent as { page: { start: number; end: number; next_cursor: string | null } }).page
const body = (r: CallToolResult) => text(r).slice(text(r).indexOf('\n') + 1, text(r).lastIndexOf('\n['))

describe('bounded tool pages', () => {
  it('reconstructs a changing source exactly and keeps errors, IDs and links intact', async () => {
    const source = Array.from({ length: 200 }, (_, i) => `unit-${i}: error E_${i}; https://example.com/task/${i}\n`).join('')
    const read = vi.fn(() => result(source))
    const pages = new ToolPages()
    let r = await pages.read('fleet_view', {}, read)
    expect(meta(r).end).toBeLessThanOrEqual(2000)
    let rebuilt = body(r)
    read.mockReturnValue(result('changed while paging'))
    while (meta(r).next_cursor) {
      r = await pages.read('fleet_view', { cursor: meta(r).next_cursor! }, read)
      rebuilt += body(r)
    }
    expect(rebuilt).toBe(source)
    expect(read).toHaveBeenCalledTimes(1)
    expect(text(r)).toContain('end of result')
  })

  it('supports explicit full reads including the same cursor snapshot', async () => {
    const pages = new ToolPages(), source = 'report\n'.repeat(10000)
    const read = vi.fn(() => result(source))
    expect(text(await pages.read('read_task_file', { task: 'u', full: true }, read))).toBe(source)
    const first = await pages.read('read_task_file', { task: 'u' }, read)
    read.mockReturnValue(result('new report'))
    expect(text(await pages.read('read_task_file', { task: 'u', cursor: meta(first).next_cursor!, full: true }, read))).toBe(source)
  })

  it('never paginates tool errors or media and does not split long indivisible IDs', async () => {
    const pages = new ToolPages(), error = { ...result('ERROR '.repeat(2000)), isError: true }
    expect(await pages.read('x', {}, () => error)).toBe(error)
    const image: CallToolResult = { content: [{ type: 'image', mimeType: 'image/png', data: 'base64' }] }
    expect(await pages.read('x', {}, () => image)).toBe(image)
    const url = 'https://example.com/' + 'a'.repeat(2500)
    const page = await pages.read('x', {}, () => result(url + '\nlast line'))
    expect(body(page)).toBe(url)
    expect(text(page)).toContain('next_cursor=')
  })

  it('rejects expired, foreign-session and mismatched-target cursors without repeating a read', async () => {
    const pages = new ToolPages(), read = vi.fn(() => result('x\n'.repeat(2000)))
    const r = await pages.read('x', { task: 'one' }, read)
    const cursor = meta(r).next_cursor!
    await expect(pages.read('x', { task: 'two', cursor }, read)).rejects.toThrow('Invalid or expired')
    await expect(new ToolPages().read('x', { task: 'one', cursor }, read)).rejects.toThrow('Invalid or expired')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000)
    try { await expect(pages.read('x', { task: 'one', cursor }, read)).rejects.toThrow('Invalid or expired') }
    finally { clock.mockRestore() }
    expect(read).toHaveBeenCalledTimes(1)
  })
})
