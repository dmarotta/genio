export interface TreeStats { bytes: number; files: number }
export interface CopySpace { availableBytes: number; requiredBytes: number }
export interface SeedReport extends Partial<TreeStats>, Partial<CopySpace> {
  seeded: boolean; reason?: 'exists' | 'missing'; method?: 'robocopy' | 'fs.cp'; estimatedBytes?: number; elapsedMs: number
}
export interface SeedOptions {
  platform?: string
  run?: (file: string, args: string[], options: { windowsHide: boolean; maxBuffer: number }) => Promise<unknown>
  statfs?: (path: string, options: { bigint: true }) => Promise<{ bavail: bigint; bsize: bigint }>
}
export function checkCopyPath(path: string): Promise<void>
export function treeStats(root: string, options?: { library?: boolean; rejectLinks?: boolean }): Promise<TreeStats>
export function checkFreeSpace(target: string, bytes: number, options?: SeedOptions): Promise<CopySpace>
export function copyLibrary(source: string, dest: string, options?: SeedOptions): Promise<'robocopy' | 'fs.cp'>
export function seedLibrary(copy: string, source: string, options?: SeedOptions): Promise<SeedReport>
