import type { SeedOptions } from './unity-seed.mjs'
/** A checkout of the project ({ path }) or a branch, tag or commit read from git objects ({ ref }). */
export type MirrorSource = { path: string } | { ref: string }
export type ResolvedSource =
  | { kind: 'checkout'; top: string; prefix: string; project: string; head?: string; branch?: string }
  | { kind: 'commit'; gitDir: string; commit: string; ref: string; prefix: string; project: string }
export type SourceInfo = { kind: 'checkout'; path: string; head?: string; branch?: string } | { kind: 'commit'; ref: string; commit: string }
export interface MirrorEntry { kind: 'file' | 'blob'; size: number; id?: string; abs?: string; mtimeMs?: number; gitDir?: string; oid?: string; stores?: string[] }
export interface MirrorScan { entries: Map<string, MirrorEntry>; warnings: string[]; scanMs: number }
export interface MirrorProgress { phase: 'scanning' | 'deleting' | 'copying' | 'library'; files?: { done: number; total: number }; bytes?: { done: number; total: number } }
export interface MirrorFiles {
  /** Files in the source under the Unity root. */
  source: number
  unchanged: number; added: number; updated: number
  /** Unchanged in the source, rewritten by Unity in the copy, copied back. */
  restored: number
  /** Gone from the source, deleted from the copy. */
  deleted: number
  /** Made by Unity in the copy and deleted; kept: .meta files for source assets, packages-lock.json, ProjectSettings. */
  unityMadeDeleted: number; unityMadeKept: number
}
export interface RestartAdvice { needed: boolean; reasons: string[]; unityVersion?: string; previousUnityVersion?: string }
export interface MirrorReport {
  /** The copy had never been synced. */
  first: boolean
  complete: boolean
  files: MirrorFiles
  bytes: { copied: number; deleted: number }
  /** resolved: pointers replaced from a local LFS store; pointers: files still pointers (never downloaded). */
  lfs: { resolved: number; pointers: string[] }
  /** Restart the editor instead of a hot sync: Unity version, packages or ProjectSettings changed. */
  restart: RestartAdvice
  warnings: string[]
  elapsedMs: number; scanMs: number
  /** reused: files an interrupted sync had already staged, applied without reading the source again. */
  staged?: { reused: number }
}
export interface MirrorOptions {
  beforeApply?: (restart: RestartAdvice) => Promise<void>
  signal?: AbortSignal
  onProgress?: (progress: MirrorProgress) => void
  /** Tests: a slow or failing copy. */
  io?: { copyFile?: (from: string, to: string) => Promise<void> }
  /** Bytes the caller will write next (a Library seed), for the one free-space check. */
  extraBytes?: number
  statfs?: SeedOptions['statfs']
  concurrency?: number
  /** Unity-root-relative paths never mirrored, such as huge local bakes. */
  exclude?: string[]
  env?: Record<string, string | undefined>
}
export const GENIO_PACKAGE: string
export const RESTART_FILES: string[]
export function mirrorSkip(rel: string, exclude?: string[]): boolean
export function unityVersionOf(root: string): string | undefined
export function resolveSource(project: string, engineRoot: string | undefined, source: MirrorSource, options?: { env?: Record<string, string | undefined> }): Promise<ResolvedSource>
/** True when the source's checkout, worktree metadata or ref is gone; never throws. */
export function sourceMissing(project: string, source: MirrorSource, options?: { env?: Record<string, string | undefined> }): Promise<boolean>
export function describeSource(source: ResolvedSource): SourceInfo
export function scanSource(source: ResolvedSource, options?: { exclude?: string[]; env?: Record<string, string | undefined> }): Promise<MirrorScan>
export function applyMirror(scan: MirrorScan, root: string, manifestFile: string, options?: MirrorOptions): Promise<MirrorReport>
export function removeFile(path: string, options?: { retries?: number }): Promise<void>
