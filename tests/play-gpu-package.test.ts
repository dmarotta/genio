import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// The fast path ships as C# source in com.genio.play, which Genio embeds in every player copy: no native plugin, no
// experimental leftovers, and a session that only uses it when Genio passes its process id.
const pkg = path.resolve(__dirname, '../resources/unity/com.genio.play')
const read = (rel: string) => fs.readFileSync(path.join(pkg, rel), 'utf8')
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)])

describe('com.genio.play GPU stream', () => {
  it('ships as reviewable source in the runtime assembly, with no binary and no spike define', () => {
    expect(fs.existsSync(path.join(pkg, 'Experimental'))).toBe(false)
    expect(files(pkg).filter(f => /\.(dll|so|dylib|pdb)$/i.test(f))).toEqual([])
    for (const file of files(pkg)) expect(fs.readFileSync(file, 'utf8'), file).not.toContain('GENIO_PLAY_GPU_SHARE')
    expect(JSON.parse(read('Runtime/Genio.Play.asmdef')).defineConstraints ?? []).toEqual([])
    for (const name of ['D3D11Ring.cs', 'GpuFrames.cs']) expect(fs.existsSync(path.join(pkg, 'Runtime', name))).toBe(true)
  })
  it('keeps JPEG unless Genio passes its process id, and keeps audio and input on the same session', () => {
    const session = read('Runtime/StreamSession.cs')
    expect(session).toContain('public static string StartStream(int port, string token, int width = 1280, int height = 720, int genioPid = 0)')
    expect(session).toContain('if (genioPid > 0) StartGpu();')
    expect(session).toContain('StartAudio?.Invoke(current);')
    expect(session).toContain('EncodeArrayToJPG(pixels, GraphicsFormat.R8G8B8A8_UNorm, (uint)width, (uint)height, 0, 75)')
  })
  it('holds the editor to 60 fps while a session runs, keeps a lower project cap, and restores both settings at its end', () => {
    const session = read('Runtime/StreamSession.cs')
    expect(session).toContain('public static int CappedFrameRate(int projectTarget) => projectTarget > 0 && projectTarget < 60 ? projectTarget : 60;')
    expect(session).toContain('current.oldTargetFrameRate = Application.targetFrameRate; current.oldVSync = QualitySettings.vSyncCount;')
    expect(session).toContain('QualitySettings.vSyncCount = 0;')
    expect(session).toContain('Application.targetFrameRate = CappedFrameRate(current.oldTargetFrameRate);')
    expect(session).toContain('Application.targetFrameRate = oldTargetFrameRate; QualitySettings.vSyncCount = oldVSync;')
    // The same rule as the C#: 0 (none) and anything above 60 become 60; 1-59 stays.
    const cap = (n: number) => n > 0 && n < 60 ? n : 60
    expect([0, -1, 30, 59, 60, 144].map(cap)).toEqual([60, 60, 30, 59, 60, 60])
  })
  it('writes the messages main parses: GR v2 with a 40-byte header, GF v1 of 32 bytes, GX v1 of 4', () => {
    const frames = read('Runtime/GpuFrames.cs')
    expect(frames).toContain("m[0] = (byte)'G'; m[1] = (byte)'R'; m[2] = 2; m[3] = Slots;")
    expect(frames).toContain('var m = new byte[40 + 8 * Slots];')
    expect(frames).toContain("message[0] = (byte)'G'; message[1] = (byte)'F'; message[2] = 1;")
    expect(frames).toContain('var message = new byte[32];')
    expect(frames).toContain("new byte[] { (byte)'G', (byte)'X', 1, code }")
    expect(frames).toContain('{\\"type\\":\\"free\\",\\"gen\\":(\\\\d{1,9}),\\"slot\\":(\\\\d)\\\\}')
  })
})
