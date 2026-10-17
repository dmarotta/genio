'use strict'
/**
 * The Kokoro voice helper (docs/voice.md, src/main/voice-output.ts). Genio starts it as its own process (Electron run as
 * Node) and talks to it over pipes only: it is never loaded into Genio's main or renderer process.
 *
 *   node kokoro-helper.cjs <sherpa-onnx.node> <model dir> <threads>
 *
 * It loads the player's downloaded sherpa-onnx addon (Apache-2.0, with espeak-ng, GPL-3.0, built in) and the Kokoro
 * model once, then reads one JSON line per sentence on stdin, `{"id":1,"text":"..."}`, and answers each with a frame on
 * stdout: a u32 LE header length, the JSON header, a u32 LE payload length, the payload. Headers:
 *   {"type":"ready","rate":24000}            once, after loading (no payload)
 *   {"type":"audio","id":1,"rate":24000}     the sentence as mono Float32 LE PCM
 *   {"type":"error","id":1,"message":"..."}  that sentence failed
 *   {"type":"fatal","message":"..."}         loading failed; the helper exits
 * It exits when stdin closes, so it never outlives Genio.
 */
const path = require('node:path')
const readline = require('node:readline')

const [addonFile, modelDir, threads] = process.argv.slice(2)

function frame(header, payload = Buffer.alloc(0)) {
  const head = Buffer.from(JSON.stringify(header), 'utf8')
  const lengths = Buffer.alloc(8)
  lengths.writeUInt32LE(head.length, 0)
  lengths.writeUInt32LE(payload.length, 4)
  process.stdout.write(Buffer.concat([lengths.subarray(0, 4), head, lengths.subarray(4), payload]))
}

const message = (e) => String((e && e.message) || e)

let addon, tts
try {
  addon = require(addonFile)
  tts = addon.createOfflineTts({
    model: {
      kokoro: {
        model: path.join(modelDir, 'model.onnx'),
        voices: path.join(modelDir, 'voices.bin'),
        tokens: path.join(modelDir, 'tokens.txt'),
        dataDir: path.join(modelDir, 'espeak-ng-data')
      },
      numThreads: Number(threads) || 2,
      provider: 'cpu',
      debug: 0
    },
    maxNumSentences: 1
  })
  frame({ type: 'ready', rate: addon.getOfflineTtsSampleRate(tts) })
} catch (e) {
  frame({ type: 'fatal', message: message(e) })
  process.stdout.end(() => process.exit(1))
}

if (tts) {
  const lines = readline.createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    let req
    try { req = JSON.parse(line) } catch { return }
    try {
      // Speaker 0 (af), normal speed.
      const audio = addon.offlineTtsGenerate(tts, { text: String(req.text || ''), sid: 0, speed: 1.0, enableExternalBuffer: false })
      const pcm = Float32Array.from(audio.samples)
      frame({ type: 'audio', id: req.id, rate: audio.sampleRate }, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
    } catch (e) {
      frame({ type: 'error', id: req.id, message: message(e) })
    }
  })
  lines.on('close', () => process.exit(0))
}
