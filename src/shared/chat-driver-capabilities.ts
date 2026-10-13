import type { ModelRuntime } from './model-catalogue'

export interface ChatDriverCapabilities {
  mode: 'driver' | 'consultation-only'
  guardedTools: boolean
  reason?: string
}

/** Installed/authenticated is not evidence that a runtime can enforce policy.
 * Codex validates read-only execution, disabled native capabilities and ChatGPT authentication at session start.
 * Promote a runtime here only with driver-level interception/disable tests.
 */
export function chatDriverCapabilities(runtime: ModelRuntime): ChatDriverCapabilities {
  return runtime === 'claude' || runtime === 'codex'
    ? { mode: 'driver', guardedTools: true }
    : { mode: 'consultation-only', guardedTools: false, reason: 'Native tool confinement has not been verified for this chat runtime.' }
}
