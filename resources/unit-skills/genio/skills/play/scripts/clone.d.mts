export interface VolumeInfo { path: string; root: string; guid: string; fs: string; flags: number; cluster: number; driveType: number; blockClone: boolean }
export interface VolumeError { path: string; error: string }
export interface CloneHelperResult { cloned: number; copied: number; failed: number; error: number; failure?: string }
export interface CloneSystem {
  probe(paths: string[]): Promise<(VolumeInfo | VolumeError)[]>
  helper(list: string, cluster: number): Promise<CloneHelperResult>
  fsutil(file: string): Promise<string>
  build(): number
  platform(): string
  systemDrive(): string | undefined
  mounted(root: string): boolean
}
export interface CloneOptions { system?: Partial<CloneSystem> }
export type CloneProbe = { capable: true; volume: VolumeInfo; method: 'copyfile' | 'fsctl' } | { capable: false; reason: string; detached?: boolean }
export interface SeedResult { method: 'clone' | 'copy'; via?: 'copyfile' | 'fsctl'; reason?: string; files?: number; bytes?: number; cloned?: number; copied?: number; verified?: boolean | null; ms: number }
export interface VolumeVerification { shared: boolean | null; at: string; method: string; root: string; file?: string; error?: number }
export const SMALL_FILE: number
export function windowsBuild(release?: string): number
export function cloneMethod(build?: number): 'copyfile' | 'fsctl'
export function volumeKey(dir: string): string
export function volumeHome(dir: string, volumeRoot: string): string
export function volumeChild(p: string, dir: string, sub: string): string | undefined
export function volumeMissing(p: string, options?: CloneOptions): boolean
export function assertMounted(p: string, options?: CloneOptions): void
export function parseProbe(line: string): VolumeInfo | VolumeError
export function sharedExtents(output: string): boolean | null
export function probeClone(source: string, target: string, options?: CloneOptions): Promise<CloneProbe>
export function volumePlacement(project: string, anchor: string, options?: CloneOptions): Promise<string | undefined>
export function volumeVerification(data: string, guid: string): VolumeVerification | undefined
export function seedTree(source: string, dest: string, options: { skip?: (name: string, isDirectory: boolean) => boolean; fallback: () => Promise<unknown>; data?: string; system?: Partial<CloneSystem> }): Promise<SeedResult>
