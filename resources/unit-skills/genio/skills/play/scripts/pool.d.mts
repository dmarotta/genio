export interface PoolLease { id: number; token: string; root: string }
export class PlayPool {
  constructor(data: string, world: string, engineRoot?: string)
  dir: string
  root(id: number): string
  state(): Promise<import('../../../../../../src/shared/play').PlayPoolState>
  configure(cap: number): Promise<void>
  acquire(owner: string, pid?: number, preferred?: number, takeover?: boolean): Promise<PoolLease | null>
  check(id: number, token: string): Promise<string>
  release(id: number, token: string): Promise<void>
  cancel(owner: string, pid?: number): Promise<void>
  mainControl(): Promise<void>
  releaseMain(): Promise<void>
  prepare(id: number, token: string, source?: string): Promise<string>
  estimate(): Promise<number>
  validateCopy(id: number): Promise<void>
}
export function poolDirectory(data: string, world: string): string
