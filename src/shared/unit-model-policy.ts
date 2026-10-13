/** Unit launches must never inherit a premium model from a CLI's mutable default. */
export const CODEX_UNIT_MODEL = 'gpt-6.1-sol'
export const CLAUDE_UNIT_MODEL = 'claude-sonnet-5-5'

export function unitModel(harness: string, model?: string): string | undefined {
  const pick = model?.trim()
  if (pick && !/^(auto|default)$/i.test(pick)) return pick
  return harness === 'codex' ? CODEX_UNIT_MODEL : harness === 'claude' ? CLAUDE_UNIT_MODEL : pick || undefined
}

/** Includes aliases, dated versions and provider-qualified model IDs. */
export function approvalModel(model?: string): boolean {
  return /(?:^|[^a-z])(fable|astra)(?:[^a-z]|$)/i.test(model ?? '')
}

export const UNIT_MODEL_APPROVAL_REASON = 'Fable and Astra need explicit approval for every launch, including respawns and Recon upgrades. Pins, usage mode and automatic recovery do not grant approval. Astra is normally reserved for heavy visual work; ordinary coding uses Sol, Sonnet or Opus.'
