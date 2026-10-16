import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

export const DEFAULT_PAGE_CHARS = 2000
export const pageShape = {
  cursor: z.string().optional().describe('Continuation cursor; repeat the original arguments.'),
  page_size: z.number().int().min(200).max(10000).optional().describe('Characters of content per page (default 2000).'),
  full: z.boolean().optional().describe('Explicitly return the entire result.')
}
export interface PageArgs { cursor?: string; page_size?: number; full?: boolean }

const PAGED = new Set(['fleet_view', 'unit_state', 'read_task_file', 'terminal_tail', 'quest_list', 'choice_list',
  'world_list', 'world_posture', 'status_report', 'memory_read', 'memory_report', 'mail_list', 'dispatch_profiles',
  'loadout_preview', 'toolchain_check', 'ally_list', 'assets_find', 'asset_info', 'asset_locate', 'fal_models',
  'generation_status', 'play_status', 'play_console', 'play_stats', 'procedure_read', 'skill_read', 'genio_help', 'settings_read', 'event_read'])
export const isPagedTool = (name: string): boolean => PAGED.has(name)

interface Snapshot { key: string; text: string; at: number }

/** Session-local immutable snapshots: continuing a live log never skips newly shifted
 * lines or repeats a side effect (e.g. filing a status report). Cursors expire loudly.
 * Page size is a target: an indivisible token (ID/URL) may exceed it. Nothing is lost.
 */
export class ToolPages {
  private snapshots = new Map<string, Snapshot>()

  async read(name: string, args: Record<string, unknown> & PageArgs, read: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
    const { cursor, full, page_size, ...query } = args
    const key = JSON.stringify([name, query])
    const size = page_size ?? DEFAULT_PAGE_CHARS
    let id: string, snapshot: Snapshot, offset = 0
    for (const [k, v] of this.snapshots) if (Date.now() - v.at > 30 * 60_000) this.snapshots.delete(k)
    if (cursor) {
      const match = /^([a-f0-9]{24}):(\d+)$/.exec(cursor)
      const saved = match && this.snapshots.get(match[1])
      if (!match || !saved || saved.key !== key) throw new Error('Invalid or expired page cursor; repeat the original read without cursor (or full=true).')
      id = match[1]
      snapshot = saved
      offset = Number(match[2])
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= snapshot.text.length) throw new Error('Invalid page offset')
    } else {
      const result = await read()
      // Errors and non-text media are never sliced or hidden behind a cursor.
      if (result.isError || result.content.some(c => c.type !== 'text') || full) return result
      const text = result.content.map(c => c.type === 'text' ? c.text : '').join('\n')
      if (text.length <= size) return result
      id = randomBytes(12).toString('hex')
      snapshot = { key, text, at: Date.now() }
      this.snapshots.set(id, snapshot)
      let chars = [...this.snapshots.values()].reduce((n, s) => n + s.text.length, 0)
      while (this.snapshots.size > 32 || (chars > 8_000_000 && this.snapshots.size > 1)) {
        const oldest = this.snapshots.keys().next().value!
        chars -= this.snapshots.get(oldest)!.text.length
        this.snapshots.delete(oldest)
      }
    }
    if (full) return { content: [{ type: 'text', text: snapshot.text }] }
    let end = Math.min(offset + size, snapshot.text.length)
    if (end < snapshot.text.length) {
      // Prefer complete lines; otherwise split only at whitespace, never inside
      // an error code, task ID, path, URL or UTF-16 surrogate pair.
      const line = snapshot.text.lastIndexOf('\n', end - 1)
      if (line >= offset) end = line + 1
      else {
        while (end > offset && !/\s/.test(snapshot.text[end - 1])) end--
        if (end === offset) {
          end = offset + size
          while (end < snapshot.text.length && !/\s/.test(snapshot.text[end])) end++
        }
      }
    }
    const next = end < snapshot.text.length ? `${id}:${end}` : null
    const page = { start: offset, end, total: snapshot.text.length, next_cursor: next }
    return {
      content: [{ type: 'text', text: `[${name} characters ${offset}-${end}/${snapshot.text.length}]\n${snapshot.text.slice(offset, end)}\n[${next ? `next_cursor=${next}; repeat original arguments` : 'end of result'}; full=true for entire result]` }],
      structuredContent: { page }
    }
  }
}
