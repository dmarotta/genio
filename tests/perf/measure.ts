/**
 * Measurement helpers shared by the perf harness: timing, single readings and
 * the summary table. Browser-safe (no Node imports) so the jsdom renderer
 * benchmarks can use it too; Node-only helpers live in support.ts.
 */
import type { ChatMessage } from '../../src/shared/types'

export interface Stat { label: string; n: number; median: number; mean: number; p95: number; max: number; unit: string; note?: string }

const results: Stat[] = []

const fmt = (n: number): string => (Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2))

export function summarise(label: string, samples: number[], unit: string, note?: string): Stat {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
  const stat: Stat = { label, n: samples.length, median: at(0.5), mean: samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length), p95: at(0.95), max: sorted[sorted.length - 1] ?? 0, unit, note }
  results.push(stat)
  console.log(`[perf] ${label}: median ${fmt(stat.median)} ${unit} (mean ${fmt(stat.mean)}, p95 ${fmt(stat.p95)}, max ${fmt(stat.max)}, n=${stat.n})${note ? ` — ${note}` : ''}`)
  return stat
}

/** A single measured number (bytes, counts): recorded in the same table. */
export function note(label: string, value: number, unit: string, extra?: string): Stat {
  return summarise(label, [value], unit, extra)
}

export function timeIt(label: string, fn: () => void, opts: { iterations?: number; warmup?: number; note?: string } = {}): Stat {
  const { iterations = 20, warmup = 2 } = opts
  for (let i = 0; i < warmup; i++) fn()
  const samples: number[] = []
  for (let i = 0; i < iterations; i++) {
    const t = performance.now()
    fn()
    samples.push(performance.now() - t)
  }
  return summarise(label, samples, 'ms', opts.note)
}

export async function timeAsync(label: string, fn: () => Promise<void>, opts: { iterations?: number; warmup?: number; note?: string } = {}): Promise<Stat> {
  const { iterations = 5, warmup = 1 } = opts
  for (let i = 0; i < warmup; i++) await fn()
  const samples: number[] = []
  for (let i = 0; i < iterations; i++) {
    const t = performance.now()
    await fn()
    samples.push(performance.now() - t)
  }
  return summarise(label, samples, 'ms', opts.note)
}

export function report(): void {
  const rows = results.map((s) => `| ${s.label} | ${fmt(s.median)} | ${fmt(s.p95)} | ${fmt(s.max)} | ${s.unit} | ${s.note ?? ''} |`)
  console.log(['', '| measure | median | p95 | max | unit | note |', '|---|---|---|---|---|---|', ...rows, ''].join('\n'))
}

// ------------------------------------------------------------------ synthetic chat

const ISO = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString()
const seq = (n: number): number[] => Array.from({ length: n }, (_, i) => i)
export const word = (i: number): string => ['hud', 'quest', 'squad', 'inventory', 'play', 'chat', 'panel', 'rail', 'answers', 'unit'][i % 10]
const LOREM = 'Genio deploys a squad of autonomous coding agents, gives each one an isolated git worktree, watches them to completion, and brings you finished pull requests. '

/** A realistic chat log: player turns, Genio turns with tool traces (up to 2000+4000 chars each), system notes and errors. */
export function syntheticMessages(wksp: string, n = 1760, withTools = true): ChatMessage[] {
  const out: ChatMessage[] = []
  for (let i = 0; i < n; i++) {
    const ts = ISO(n - i)
    const r = i % 10
    if (r === 0 || r === 5) out.push({ id: `p-${i.toString(16).padStart(6, '0')}`, wksp, role: 'player', text: `Please ${word(i)} the ${word(i + 2)} and report back. ${LOREM.slice(0, 60 + (i % 90))}`, ts, provider: 'claude' })
    else if (r === 9 && i % 30 === 9) out.push({ id: `s-${i.toString(16).padStart(6, '0')}`, wksp, role: 'system', text: `Answered: ${word(i)} question\n\n${word(i + 1)}`, ts })
    else if (r === 8 && i % 20 === 8) out.push({ id: `e-${i.toString(16).padStart(6, '0')}`, wksp, role: 'error', text: 'Genio session stopped: session ended', ts })
    else {
      const tools = withTools ? seq(i % 4 === 0 ? 3 : i % 3 === 0 ? 0 : 1).map((k) => ({ id: `toolu_${i}_${k}`, name: k ? 'mcp__genio__fleet_view' : 'mcp__genio__unit_status', input: JSON.stringify({ unit: `${word(i)}-${i}`, page_size: 2000, cursor: null }), result: LOREM.repeat(12).slice(0, k === 0 ? 1200 : 4000), isError: false })) : []
      const text = i % 7 === 0 ? `## ${word(i)} report\n\n${LOREM.repeat(4)}\n\n- **${word(i + 1)}**: done\n- \`${word(i + 2)}\`: pending\n\n\`\`\`ts\nconst x = ${i}\n\`\`\`\n` : i % 3 === 0 ? '' : `${LOREM.slice(0, 80 + (i % 200))}`
      out.push({ id: `m-msg_${i.toString(16).padStart(6, '0')}`, wksp, role: 'genio', text, ts, tools, provider: 'claude', providerModel: 'claude-opus-5-5', costUsd: 0.012 })
    }
  }
  return out
}
