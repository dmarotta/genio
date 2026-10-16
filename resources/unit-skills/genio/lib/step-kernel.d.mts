export interface Who { tool: string; cli: string; thing: string; key: string }
interface StepLike { id: string; parent: string | null }
interface ManifestLike<S extends StepLike = StepLike> {
  branch: string; branches: Record<string, { head: string | null; from: string | null }>; steps: S[]; history: Record<string, unknown>[]
}

export const NAME: RegExp
export const now: () => string
export const stepId: (n: number) => string
export const rel: (dir: string, p: string) => string
export const sha256: (file: string) => string
export const readJson: (file: string) => any
export const pause: (ms: number) => void
export const sleep: (ms: number) => Promise<void>
export function assertOutside(dir: string, roots: (string | undefined | null)[], message: string): void
export function checkName(kind: string, name: string | undefined): string
export function renameRetry(from: string, to: string): void
export function writeManifest(dir: string, m: { updated?: string }): void
export const alive: (pid: number) => boolean
export function withLock<T>(dir: string, fn: () => Promise<T>, who: Who): Promise<T>
export const byId: <S extends StepLike>(m: ManifestLike<S>, id: string) => S | undefined
export function line<S extends StepLike>(m: ManifestLike<S>, branch?: string): S[]
export function chain<S extends StepLike>(m: ManifestLike<S>, id: string | null): S[]
export function resolveStep<S extends StepLike>(m: ManifestLike<S>, ref: string | number): S
export function dirBytes(dir: string): number
export function revertHead(m: ManifestLike, to: string | number, who: Who): { reverted: string | null }
export function addBranch(m: ManifestLike, name: string, from: string | number | undefined, who: Who): void
export function switchTo(m: ManifestLike, name: string): void
