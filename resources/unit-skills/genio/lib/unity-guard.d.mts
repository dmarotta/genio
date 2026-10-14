import type { UnityUnitConfig } from '../../../../src/main/unity-unit'
export const RULE: string
export const GUARD_MATCHER: string
export function canonicalPath(value: string, cwd?: string): string
export function unityPoolPaths(config: UnityUnitConfig): { dir: string; copies: string }
export function playerUnityRoots(config: UnityUnitConfig): string[]
export function leasedUnityRoots(config: UnityUnitConfig, options?: { now?: number; isAlive?: (pid: number) => boolean }): string[]
export function loadGuardConfig(file: string): UnityUnitConfig
export function rawUnityReason(command: string): string | undefined
export function guardTool(input: { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string; permission_mode?: string }, config: UnityUnitConfig, options?: { now?: number; isAlive?: (pid: number) => boolean }): string | undefined
export function recordUnityIncident(config: UnityUnitConfig, incident: Record<string, unknown>): void
export function guardMain(argv?: string[], env?: NodeJS.ProcessEnv): Promise<number>
