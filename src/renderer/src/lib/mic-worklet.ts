/**
 * The AudioWorklet that collects the microphone for voice input (mic.ts): each render quantum's samples go to the page
 * as a copy. Bundled as its own file (`?worker&url`), so it loads from the app's origin under the renderer's CSP.
 */
/** mic.ts's MIC_PROCESSOR (not imported: mic.ts loads this file). */
const MIC_PROCESSOR = 'genio-mic'

declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void
declare class AudioWorkletProcessor { readonly port: MessagePort }

registerProcessor(MIC_PROCESSOR, class extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const mono = inputs[0]?.[0]
    if (mono?.length) this.port.postMessage(mono.slice())
    return true
  }
})
