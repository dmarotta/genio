export const MASTER_RATE: number
export const QUIET_BITS: number

export interface AudioInfo { source_bits: number | null; eff_bits: number | null; source_clipped: number; loop: boolean }
export interface Audio { rate: number; data: Float32Array[]; info: AudioInfo }
export interface Seam { jump: number; step_db: number }
export interface Metrics {
  duration_s: number; samples: number; rate: number; channels: number
  peak_dbfs: number | null; true_peak_dbtp: number | null; rms_dbfs: number | null; lufs: number | null
  clipped: number; source_clipped: number; source_bits: number | null; eff_bits: number | null
  lead_silence_s: number; tail_silence_s: number; stereo_corr: number | null; loop: boolean; seam: Seam | null; expect_s: number | null
}
export type Op = Record<string, Record<string, unknown>>

export function makeAudio(rate: number, data: Float32Array[], info?: Partial<AudioInfo>): Audio
export function readWav(input: string | Buffer): Audio
export function readPcm16(buf: Buffer, rate: number, channels: number): Audio
export function encodeWav(audio: Audio, opts?: { bits?: 16 | 24 | 32 }): Buffer
export function writeWav(file: string, audio: Audio, opts?: { bits?: 16 | 24 | 32 }): void
export function resample(audio: Audio, rate: number): Audio
export function trim(audio: Audio, opts?: { db?: number; pad_ms?: number; start?: boolean; end?: boolean }): { audio: Audio; note?: string }
export function cut(audio: Audio, opts?: { start_ms?: number; end_ms?: number }): Audio
export function fade(audio: Audio, opts?: { in_ms?: number; out_ms?: number; shape?: 'linear' | 'equal' }): Audio
export function gain(audio: Audio, opts?: { db?: number }): Audio
export function normalize(audio: Audio, opts: { peak_db?: number; lufs?: number; ceiling_db?: number }): { audio: Audio; note?: string }
export function loop(audio: Audio, opts?: { crossfade_ms?: number }): Audio
export function mix(audio: Audio, other: Audio, opts?: { gain_db?: number; offset_ms?: number }): Audio
export function channels(audio: Audio, opts?: { count?: 1 | 2 }): Audio
export const OPS: Record<string, string>
export function applyOp(audio: Audio, op: Op, ctx?: { take?: (ref: string) => Audio }): { audio: Audio; note?: string }
export function applyOps(audio: Audio, ops?: Op[], ctx?: { take?: (ref: string) => Audio }): { audio: Audio; notes: string[] }
export function checkOps(ops: unknown): Op[]
export function truePeak(audio: Audio): number
export function loudness(audio: Audio): number | null
export function seam(audio: Audio): Seam | null
export function measure(audio: Audio, opts?: { loop?: boolean; expect_s?: number | null }): Metrics
export function warningsFor(m: Metrics): string[]
export function encodePng(width: number, height: number, rgb: Buffer): Buffer
export function renderSheet(audio: Audio, opts?: { title?: string; metrics?: Metrics; warnings?: string[]; width?: number }): Buffer
