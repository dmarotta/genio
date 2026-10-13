export interface PlayScene { name: string; path: string; isDirty?: boolean; isActive?: boolean }
export interface PlayStatus {
  connected: boolean
  state: 'stopped' | 'playing' | 'paused' | 'compiling' | 'reloading' | 'gone'
  message?: string
  genioDriving?: boolean
  scenes: PlayScene[]
  capabilities: { resolution: boolean; input: boolean }
}
export interface PlayFrame { base64: string; width: number; height: number; capturedAt: string; latencyMs: number }
export interface PlayConsole { entries: { message: string; level?: string; stackTrace?: string; seq?: number }[]; cursor?: number; session?: string; reset?: boolean }
export interface PlayStats {
  fps?: number
  render?: { drawCalls: number; triangles: number }
  memory?: { totalAllocatedBytes: number }
  frameTiming?: { available: boolean; cpuFrameTimeMs: number; gpuFrameTimeMs: number }
}
export type PlayAction =
  | { type: 'play' | 'pause' | 'stop' }
  | { type: 'scene'; path: string }
  | { type: 'resolution'; width: number; height: number }
  | { type: 'key'; key: string }
  | { type: 'pointer'; x: number; y: number }

/** Delay after completion: no overlapping captures or catch-up bursts. */
export function snapshotDelay(latencyMs: number, failures = 0): number {
  return failures ? Math.min(10000, 1000 * 2 ** Math.min(failures, 4)) : Math.max(200, 1000 - latencyMs)
}
