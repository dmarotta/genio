/**
 * Unity's clip names for a model: a ModelImporter .meta lists clipAnimations (name, take, frame range),
 * and frames count in the file's own frame rate, which FBX stores in GlobalSettings.
 */
import { AnimationClip, AnimationUtils } from 'three'

export interface UnityClip { name: string; takeName: string; firstFrame: number; lastFrame: number }

const unquote = (v: string): string => {
  const s = v.trim()
  if (s.startsWith('"') && s.endsWith('"')) { try { return JSON.parse(s) as string } catch { return s.slice(1, -1) } }
  return s.startsWith('\'') && s.endsWith('\'') ? s.slice(1, -1).replace(/''/g, '\'') : s
}

/** The clipAnimations entries of a ModelImporter .meta; [] when it has none (Unity then uses the file's takes). */
export function unityClips(meta: string): UnityClip[] {
  const lines = meta.split(/\r?\n/)
  const start = lines.findIndex(l => /^\s*clipAnimations:\s*$/.test(l))
  if (start < 0) return []
  const indent = lines[start].search(/\S/)
  const out: UnityClip[] = []
  let clip: Partial<UnityClip> | undefined
  const flush = (): void => {
    if (clip?.name !== undefined && clip.takeName !== undefined && Number.isFinite(clip.firstFrame) && Number.isFinite(clip.lastFrame)) out.push(clip as UnityClip)
  }
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue
    const at = line.search(/\S/)
    const item = line.slice(at).startsWith('- ')
    if (at < indent || at === indent && !item) break
    if (item && at === indent) { flush(); clip = {} }
    // Entry fields sit two spaces in from the dash; deeper lines are nested (masks, events, curves).
    if (at !== indent + 2 && !(item && at === indent)) continue
    const m = /^(?:- )?(\w+):\s?(.*)$/.exec(line.slice(at))
    if (!m || !clip) continue
    if (m[1] === 'name' || m[1] === 'takeName') clip[m[1]] = unquote(m[2])
    else if (m[1] === 'firstFrame' || m[1] === 'lastFrame') clip[m[1]] = Number(m[2])
  }
  flush()
  return out.slice(0, 512)
}

/**
 * Unity's clips cut from the file's takes: a take is found by its name, or by the part after "|" (Blender
 * writes "Armature|Action"); a range covering the whole take keeps its keys. Returns undefined when no
 * entry matches a take, so the file's own clips stay.
 */
export function applyUnityClips(takes: AnimationClip[], unity: UnityClip[], fps: number): AnimationClip[] | undefined {
  const tail = (s: string): string => s.slice(s.lastIndexOf('|') + 1)
  const out: AnimationClip[] = []
  for (const u of unity) {
    const take = takes.find(t => t.name === u.takeName) ?? takes.find(t => tail(t.name) === tail(u.takeName)) ?? (takes.length === 1 ? takes[0] : undefined)
    if (!take) continue
    const whole = u.firstFrame <= 0 && u.lastFrame / fps >= take.duration - 0.5 / fps
    // Unity's last frame is part of the clip; subclip stops before its end frame.
    const clip = whole ? take.clone() : AnimationUtils.subclip(take, u.name, Math.max(0, u.firstFrame), Math.max(u.firstFrame + 1, u.lastFrame) + 1e-3, fps)
    clip.name = u.name
    out.push(clip)
  }
  return out.length ? out : undefined
}

/** FBX TimeMode values (KTime::EMode) to frames per second; 14 is "custom" (CustomFrameRate). */
const TIME_MODES: Record<number, number> = { 1: 120, 2: 100, 3: 60, 4: 50, 5: 48, 6: 30, 7: 30, 8: 29.97, 9: 29.97, 10: 25, 11: 24, 12: 1000, 13: 23.976, 15: 96, 16: 72, 17: 59.94, 18: 119.88 }

/** A GlobalSettings number of an ASCII or binary FBX, read straight from its property record. */
function fbxProperty(bytes: Uint8Array, name: string): number | undefined {
  if (new TextDecoder('latin1').decode(bytes.subarray(0, 18)) !== 'Kaydara FBX Binary') {
    const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 1 << 20)))
    const m = new RegExp(`P:\\s*"${name}",\\s*"[^"]*",\\s*"[^"]*",\\s*"[^"]*",\\s*(-?[\\d.eE+-]+)`).exec(head)
    return m ? Number(m[1]) : undefined
  }
  // Binary property: S <len> name, then three more strings (type, label, flags), then the typed value.
  const needle = [0x53, name.length, 0, 0, 0, ...[...name].map(c => c.charCodeAt(0))]
  const limit = Math.min(bytes.length, 1 << 22) - needle.length
  let i = -1
  for (let k = 0; k < limit && i < 0; k++) if (bytes[k] === 0x53 && bytes[k + 1] === name.length && needle.every((b, j) => bytes[k + j] === b)) i = k
  if (i < 0) return
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = i + needle.length
  for (let s = 0; s < 3; s++) {
    if (at + 5 > bytes.length || bytes[at] !== 0x53) return
    at += 5 + view.getUint32(at + 1, true)
  }
  if (at + 9 > bytes.length) return
  switch (String.fromCharCode(bytes[at])) {
    case 'I': return view.getInt32(at + 1, true)
    case 'D': return view.getFloat64(at + 1, true)
    case 'F': return view.getFloat32(at + 1, true)
    case 'L': return Number(view.getBigInt64(at + 1, true))
    case 'Y': return view.getInt16(at + 1, true)
  }
}

/** Frames per second an FBX states, if it states one. */
export function fbxFrameRate(buffer: ArrayBuffer): number | undefined {
  const bytes = new Uint8Array(buffer)
  const mode = fbxProperty(bytes, 'TimeMode')
  if (mode === 14) { const custom = fbxProperty(bytes, 'CustomFrameRate'); return custom && custom > 0 ? custom : undefined }
  return mode === undefined ? undefined : TIME_MODES[mode]
}
