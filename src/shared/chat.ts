import type { Ally, ChatMessage, Settings } from './types'

const ROUTED_RE = /^\[FROM GENIO MAIN corr=([\w-]+)\]\s*([\s\S]*?)(?:\n\nWhen finished \(or blocked\), answer with report_to_main[\s\S]*)?$/

/**
 * A request main Genio routed to an ally, as shown in the ally's chat tab:
 * the request text without the routing envelope, plus its correlation id.
 */
export function routedRequest(m: Pick<ChatMessage, 'role' | 'text' | 'from'>): { corr: string; text: string } | null {
  if (m.from !== 'genio' && m.role !== 'system') return null
  const hit = ROUTED_RE.exec(m.text)
  if (hit) return { corr: hit[1], text: hit[2].trim() }
  return m.from === 'genio' ? { corr: '', text: m.text } : null
}

/** The chat controls (approval mode, model, effort) every chat pane carries. */
export interface ChatControls {
  shellMode: Settings['chatShellMode']
  /** '' = the tool's default model */
  model: string
  /** '' = auto */
  effort: string
}

/** Per-ally overrides; '' clears an override so the ally follows the main chat again. */
export interface AllyControlsPatch {
  model?: string
  effort?: string
  shellMode?: Settings['chatShellMode'] | ''
}

const SHELL_MODES: readonly string[] = ['ask', 'auto-shell', 'all']

/**
 * Effective controls of a chat. The main chat reads the Genio settings
 * (chatShellMode, wkspModel, wkspEffort); an ally uses its own saved values and
 * falls back to the main chat's for anything it has not set.
 */
export function chatControls(s: Pick<Settings, 'chatShellMode' | 'wkspModel' | 'wkspEffort'> | null | undefined, ally?: Pick<Ally, 'model' | 'effort' | 'shellMode'>): ChatControls {
  return {
    shellMode: ally?.shellMode || s?.chatShellMode || 'ask',
    model: ally?.model || s?.wkspModel || '',
    effort: ally?.effort || s?.wkspEffort || ''
  }
}

/** Apply an overrides patch to an ally record (pure: returns a new record). */
export function patchAllyControls<A extends Pick<Ally, 'model' | 'effort' | 'shellMode'>>(ally: A, patch: AllyControlsPatch): A {
  const next = { ...ally }
  for (const k of ['model', 'effort', 'shellMode'] as const) {
    if (!(k in patch)) continue
    const v = patch[k]?.trim()
    if (k === 'shellMode' && v && !SHELL_MODES.includes(v)) continue
    if (v) (next as Record<string, unknown>)[k] = v
    else delete next[k]
  }
  return next
}
