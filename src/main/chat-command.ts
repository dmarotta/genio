/**
 * run_command's process: one command in a project's main copy or a unit's copy, with the system shell, never through
 * the player's terminal pane. Genio's paid-provider keys and its bridge token stay out of its environment.
 */
import { runShell, type ExecResult } from './util'

const CLOSED_ENV = /^(?:FAL_KEY|UTHANA_API_KEY|GENIO_SPEND_\w+|GENIO_BRIDGE_\w+)$/i

export function runChatCommand(command: string, cwd: string, timeoutMs: number): Promise<ExecResult> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !CLOSED_ENV.test(k)))
  return runShell(command, { cwd, env, timeoutMs })
}
