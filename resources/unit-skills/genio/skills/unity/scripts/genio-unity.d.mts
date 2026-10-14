export const EXIT: Readonly<{ ok: 0; usage: 2; auth: 3; license: 4; failed: 6; unreachable: 7; testsFailed: 8; wait: 20; forbidden: 21; open: 22; leaseLost: 23 }>
export const CLI_PINNED: Readonly<{ min: string; below: string }>
export const CONFIG_SCHEMA: 'genio.unity-unit.v1'
export const RUN_SCHEMA: 'genio.unity-run.v1'
export const HELP: string
export class UnityError extends Error { code: number; constructor(code: number, message: string) }
export interface NUnitTotals { total: number; passed: number; failed: number; skipped: number; inconclusive: number; result: string; failures: string[] }
export function compareVersions(a: string, b: string): number
export function cliPinned(version: string): boolean
export function parseNUnit(xml: string): NUnitTotals | null
export function nunitToJUnit(xml: string): string
export function compileErrors(log: string): string[]
export function editorOpen(root: string): number
export function seedLibrary(copy: string, source: string): Promise<boolean>
export function projectVersion(root: string): string | undefined
export type ParsedArgs =
  | { verb: 'help' }
  | { verb: 'cmd'; name: string; parameters: Record<string, unknown> }
  | { verb: 'status' | 'compile' | 'test' | 'import' | 'build' | 'play' | 'console'; opts: Record<string, string | number | boolean> }
export function parseArgs(argv: string[]): ParsedArgs
export function main(argv?: string[]): Promise<number>
