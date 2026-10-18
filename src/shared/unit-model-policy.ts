/** Unit launches must never inherit a premium model from a CLI's mutable default. */
export const CODEX_UNIT_MODEL = 'gpt-6.1-sol'
export const CLAUDE_UNIT_MODEL = 'claude-sonnet-5-5'

/** The effort used where the player set none (Codex's own default too). */
export const DEFAULT_EFFORT = 'medium'

export function unitModel(harness: string, model?: string): string | undefined {
  const pick = model?.trim()
  if (pick && !/^(auto|default)$/i.test(pick)) return pick
  return harness === 'codex' ? CODEX_UNIT_MODEL : harness === 'claude' ? CLAUDE_UNIT_MODEL : pick || undefined
}

/** Sign-in per tool: true signed in, false not signed in (or not installed), undefined not read yet. */
export interface SignIns {
  claude?: boolean
  codex?: boolean
}

/**
 * Where the player set nothing: Claude (Sonnet 5.5), unless Claude is not
 * signed in and Codex is, then Codex (Sol 6.1). Both signed in: Claude.
 */
export const defaultProvider = (s: SignIns): 'claude' | 'codex' => (s.claude === false && s.codex === true ? 'codex' : 'claude')

/** The chat's model value (as the chat model picker stores it) where the player set none. */
export const defaultChatModel = (s: SignIns): string => (defaultProvider(s) === 'codex' ? `codex:OpenAI:${CODEX_UNIT_MODEL}` : CLAUDE_UNIT_MODEL)

/** A unit's effort where the player set none: medium, high for a Recon. */
export const defaultUnitEffort = (kind: string): string => (kind === 'scout' ? 'high' : DEFAULT_EFFORT)

/** Includes aliases, dated versions and provider-qualified model IDs. */
export function approvalModel(model?: string): boolean {
  return /(?:^|[^a-z])(fable|astra)(?:[^a-z]|$)/i.test(model ?? '')
}

export const UNIT_MODEL_APPROVAL_REASON = 'Fable and Astra need explicit approval for every launch, including respawns and Recon upgrades. A saved model choice, the usage mode and automatic recovery do not grant approval. Astra is normally reserved for heavy visual work; ordinary coding uses Sol, Sonnet or Opus.'
