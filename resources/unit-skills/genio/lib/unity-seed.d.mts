import type { CloneOptions, SeedResult } from '../skills/play/scripts/clone.mjs'
export type SeedMethod = 'robocopy' | 'fs.cp' | 'clone:copyfile' | 'clone:fsctl' | 'clone-refused-copy'
export interface TreeStats { bytes: number; files: number }
export interface CopySpace { availableBytes: number; requiredBytes: number }
export interface SeedReport extends Partial<TreeStats>, Partial<CopySpace> {
  seeded: boolean; reason?: 'exists' | 'missing' | 'submodules-missing' | 'source-submodules-missing'; method?: SeedMethod; estimatedBytes?: number; elapsedMs: number
  /** Declared submodules (from the repository top) left unchecked-out under the copy or the source project. */
  missing?: string[]
  /** The block-clone attempt: verified sharing, or why the normal copy ran instead. */
  clone?: { verified?: boolean | null; reason?: string }
}
export interface SeedOptions {
  platform?: string
  run?: (file: string, args: string[], options: { windowsHide: boolean; maxBuffer: number }) => Promise<unknown>
  statfs?: (path: string, options: { bigint: true }) => Promise<{ bavail: bigint; bsize: bigint }>
  /** Genio data folder recording each volume's one-time sharing check. */
  data?: string
  /** false skips block cloning; otherwise injected probe/helper fixtures. */
  clone?: false | CloneOptions
}
export function checkCopyPath(path: string): Promise<void>
export function treeStats(root: string, options?: { library?: boolean; rejectLinks?: boolean }): Promise<TreeStats>
export function checkFreeSpace(target: string, bytes: number, options?: SeedOptions): Promise<CopySpace>
export function robocopyTree(source: string, dest: string, options?: { run?: SeedOptions['run']; excludeDirs?: string[]; excludeFiles?: string[]; label?: string }): Promise<'robocopy'>
export function copyLibrary(source: string, dest: string, options?: SeedOptions): Promise<'robocopy' | 'fs.cp'>
export function cloneOrCopyLibrary(source: string, dest: string, options?: SeedOptions): Promise<{ method: SeedMethod; clone?: SeedResult }>
export function seedLibrary(copy: string, source: string, options?: SeedOptions): Promise<SeedReport>
