/**
 * The AudioWorklet that plays Play's game sound: packets arrive on its port from the live view (PlayLive.tsx), each
 * render quantum pulls from the ring in play-audio.ts. Bundled as its own file (`?worker&url`), so it loads from the
 * app's origin under the renderer's CSP (script-src 'self').
 */
import { PLAY_AUDIO_PROCESSOR, PlayAudioPlayer } from './play-audio'

// AudioWorkletGlobalScope is not in the DOM lib.
declare const sampleRate: number
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void
declare class AudioWorkletProcessor { readonly port: MessagePort }

registerProcessor(PLAY_AUDIO_PROCESSOR, class extends AudioWorkletProcessor {
  private player = new PlayAudioPlayer(sampleRate)
  constructor() {
    super()
    this.port.onmessage = ({ data }) => {
      if (data instanceof Uint8Array) this.player.packet(data)
      else if (data?.type === 'flush') this.player.flush()
    }
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]
    if (out?.length) this.player.render(out[0], out[1] ?? out[0])
    return true
  }
})
