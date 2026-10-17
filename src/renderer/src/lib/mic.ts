/**
 * The microphone for voice input (docs/voice.md): one utterance as 16 kHz mono Float32, a level for the mic button's
 * ring, a 60 s limit. The tracks stop as soon as recording ends, so Windows' mic-in-use icon goes away with it.
 * The audio only ever goes to Genio's main process (voiceTranscribe), never to disk.
 */
import workletUrl from './mic-worklet?worker&url'

export const MIC_PROCESSOR = 'genio-mic'
export const MIC_RATE = 16_000
export const MIC_LIMIT_MS = 60_000

/** getUserMedia was refused: Windows' microphone switch (or the device) blocks it. */
export class MicBlockedError extends Error {}

export interface Recording {
  /** Stop and hand back the audio. */
  stop(): Float32Array
  /** Stop and drop the audio. */
  cancel(): void
}

/** RMS of one block, 0..1. */
export function rms(block: Float32Array): number {
  let sum = 0
  for (let i = 0; i < block.length; i++) sum += block[i] * block[i]
  return block.length ? Math.sqrt(sum / block.length) : 0
}

/** The blocks as one clip, at most `max` samples. */
export function joinBlocks(blocks: Float32Array[], max = (MIC_LIMIT_MS / 1000) * MIC_RATE): Float32Array {
  const total = Math.min(max, blocks.reduce((n, b) => n + b.length, 0))
  const out = new Float32Array(total)
  let at = 0
  for (const b of blocks) {
    if (at >= total) break
    const part = b.subarray(0, total - at)
    out.set(part, at)
    at += part.length
  }
  return out
}

/** Open the mic and start collecting. `onLevel` gets 0..1 about 20 times a second; `onLimit` fires once at 60 s. */
export async function record(opts: { onLevel?: (level: number) => void; onLimit?: () => void } = {}): Promise<Recording> {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    })
  } catch (e) {
    const name = (e as DOMException)?.name
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new MicBlockedError('microphone blocked')
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new Error('No microphone found.')
    if (name === 'NotReadableError') throw new Error('The microphone is in use by another app.')
    throw e
  }
  const context = new AudioContext({ sampleRate: MIC_RATE })
  const release = (): void => {
    for (const t of stream.getTracks()) t.stop()
    void context.close().catch(() => undefined)
  }
  try {
    await context.audioWorklet.addModule(workletUrl)
    const source = context.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(context, MIC_PROCESSOR, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    // A muted path to the output keeps the worklet pulled; nothing is heard.
    const mute = context.createGain()
    mute.gain.value = 0
    source.connect(node).connect(mute).connect(context.destination)
    const limit = (MIC_LIMIT_MS / 1000) * MIC_RATE
    const blocks: Float32Array[] = []
    let samples = 0, level = 0, sent = 0, done = false
    node.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
      if (done) return
      blocks.push(data)
      samples += data.length
      level = Math.max(rms(data), level * 0.85)
      if (opts.onLevel && performance.now() - sent > 50) { sent = performance.now(); opts.onLevel(Math.min(1, level * 4)) }
      if (samples >= limit) { done = true; opts.onLimit?.() }
    }
    const end = (): void => {
      done = true
      node.port.onmessage = null
      source.disconnect()
      release()
    }
    return {
      stop: () => { end(); return joinBlocks(blocks, limit) },
      cancel: () => { end(); blocks.length = 0 }
    }
  } catch (e) {
    release()
    throw e
  }
}
