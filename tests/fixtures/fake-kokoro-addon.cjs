'use strict'
// A stand-in for sherpa-onnx.node in tests (no model): the calls resources/kokoro-helper.cjs makes, with 0.1 s of a
// 220 Hz tone per word. "slow" in the text blocks for 1.5 s like a long sentence; "fail" throws. FAKE_KOKORO_FATAL makes
// loading fail. The config the helper passed is written to <model dir>/config.json, and each request's text and speaker
// id to a line of <model dir>/requests.jsonl.
const fs = require('node:fs')
const path = require('node:path')

const RATE = 24000
let modelDir = ''

exports.createOfflineTts = (config) => {
  if (process.env.FAKE_KOKORO_FATAL) throw new Error('fake model is broken')
  modelDir = path.dirname(config.model.kokoro.model)
  fs.writeFileSync(path.join(modelDir, 'config.json'), JSON.stringify(config))
  return { config }
}

exports.getOfflineTtsSampleRate = () => RATE

exports.offlineTtsGenerate = (_handle, req) => {
  fs.appendFileSync(path.join(modelDir, 'requests.jsonl'), JSON.stringify({ text: req.text, sid: req.sid }) + '\n')
  if (req.text.includes('fail')) throw new Error('fake failure')
  if (req.text.includes('slow')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)
  const n = req.text.split(/\s+/).filter(Boolean).length * RATE / 10
  const samples = new Float32Array(n)
  for (let i = 0; i < n; i++) samples[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / RATE)
  return { samples, sampleRate: RATE }
}
