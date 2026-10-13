import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Film, FolderOpen, Play, Save, Sparkles } from 'lucide-react'
import type { FalRun } from '@shared/api'
import {
  DEFAULT_SPRITE_SETTINGS, SPRITE_PRESETS, alignFrame, directionLabel, hasTransparency, packSheet, playbackIndex,
  type SpriteAsset, type SpriteFrame, type SpriteProject, type SpriteQuote, type SpriteSettings
} from '@shared/sprites'
import { fmtUsd } from '@shared/fal'
import { api, errText, useStore } from '../store'
import { Confirm, Field, ViewHeader } from '../components/ui'
import { decodeImage, encodeImage, generatedFrames, sampleVideo, videoReference } from '../lib/sprites'
import '../styles/sprites.css'

// A job and its draft survive navigation. Paid steps stop between calls when requested.
let session: { project: SpriteProject | null; busy: string; error: string; saved: string } = { project: null, busy: '', error: '', saved: '' }
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
const update = (patch: Partial<typeof session>) => { session = { ...session, ...patch }; listeners.forEach(fn => fn()) }
let saveTimer: ReturnType<typeof setTimeout> | undefined
let cancelled = false
function newProject(world: string | null): SpriteProject {
  return { schema: 'genio.sprite-project.v1', id: crypto.randomUUID(), world, name: 'sprite-animation', prompt: '', source: '',
    settings: { ...DEFAULT_SPRITE_SETTINGS, pivot: { ...DEFAULT_SPRITE_SETTINGS.pivot } }, frames: [], runIds: [], generations: [], updatedAt: new Date().toISOString() }
}
function draft(p: SpriteProject): void {
  update({ project: p, saved: 'Saving…' })
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void api().spriteSave(p).then(() => { if (session.project === p) update({ saved: 'Saved in Genio' }) }).catch(e => update({ saved: '', error: errText(e) }))
  }, 400)
}
async function checkpoint(p: SpriteProject): Promise<void> {
  clearTimeout(saveTimer); update({ project: p })
  await api().spriteSave(p); update({ saved: 'Saved in Genio' })
}
function checkStop(): void { if (cancelled) throw new Error('Stopped. Completed frames and FAL runs are saved; no further calls were submitted.') }
async function waitRun(initial: FalRun): Promise<FalRun> {
  let run = initial
  while (['submitting', 'queued', 'running'].includes(run.status)) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    const found = (await api().falRuns()).find(r => r.id === run.id)
    if (!found) throw new Error('FAL run is missing from history.')
    run = found
  }
  if (run.status !== 'completed') throw new Error(run.error ?? `FAL run ${run.status}. No automatic retries.`)
  return run
}

export function Sprites() {
  const state = useSyncExternalStore(subscribe, () => session)
  const worlds = useStore(s => s.snap.projects)
  const [world, setWorld] = useState<string | null>(() => {
    if (session.project) return session.project.world
    const saved = localStorage.getItem('genio.sprites.world')
    return saved === null ? worlds[0]?.name ?? null : worlds.some(w => w.name === saved) ? saved : null
  })
  const [projects, setProjects] = useState<SpriteProject[]>([])
  const [assets, setAssets] = useState<SpriteAsset[]>([])
  const [selected, setSelected] = useState(0)
  const [direction, setDirection] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [tick, setTick] = useState(0)
  const [onion, setOnion] = useState(false)
  const [individual, setIndividual] = useState(false)
  const [unity, setUnity] = useState(false)
  const [alpha, setAlpha] = useState('No frames')
  const [confirm, setConfirm] = useState<{ title: string; body: string; action: () => Promise<void> } | null>(null)
  const [custom, setCustom] = useState(false)
  const mounted = useRef(true)
  const p = state.project, busy = !!state.busy
  const frames = p?.frames.filter(f => f.direction === direction) ?? []
  const previewIndex = playbackIndex(tick, frames.length, p?.settings.playback ?? 'loop')
  const current = playing ? frames[previewIndex] : p?.frames[selected]
  const currentIndex = playing ? previewIndex : frames.findIndex(f => f.id === current?.id)
  const prev = frames[(currentIndex + frames.length - 1) % frames.length]

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let live = true
    if (session.project?.world !== world) update({ project: null, error: '' })
    void Promise.all([api().spriteList(world), api().spriteAssets(world)]).then(([saved, images]) => {
      if (!live) return
      setProjects(saved); setAssets(images)
      if (!session.project) update({ project: saved[0] ?? newProject(world) })
    }).catch(e => { if (live) update({ error: errText(e) }) })
    return () => { live = false }
  }, [world])
  useEffect(() => {
    if (!playing || !p) return
    const timer = setInterval(() => setTick(t => t + 1), 1000 / p.settings.fps)
    return () => clearInterval(timer)
  }, [playing, p?.settings.fps])
  useEffect(() => {
    let live = true
    if (!p?.frames.length) { setAlpha('No frames'); return }
    void Promise.all(p.frames.map(f => decodeImage(f.image).then(hasTransparency))).then(results => {
      if (live) setAlpha(results.every(Boolean) ? 'Transparency present in every frame' : `${results.filter(v => !v).length} frames have no transparent pixels — inspect the background`)
    }).catch(e => { if (live) setAlpha(errText(e)) })
    return () => { live = false }
  }, [p?.frames])
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      if (session.busy || !session.project) return
      const file = [...(e.clipboardData?.files ?? [])].find(f => f.type.startsWith('image/'))
      if (file) { e.preventDefault(); void importFile(file) }
    }
    window.addEventListener('paste', paste); return () => window.removeEventListener('paste', paste)
  }, [])

  async function work(label: string, action: () => Promise<void>): Promise<void> {
    if (session.busy) return
    cancelled = false; update({ busy: label, error: '' })
    try { await action() } catch (e) { update({ error: errText(e) }) }
    finally { update({ busy: '' }) }
  }
  const patch = (change: Partial<SpriteProject>) => { if (p) draft({ ...p, ...change }) }
  const settings = (change: Partial<SpriteSettings>) => { if (p) patch({ settings: { ...p.settings, ...change } }) }
  async function switchProject(id?: string, nextWorld = world): Promise<void> {
    await work('Opening animation…', async () => {
      if (p) await checkpoint(p)
      const saved = await api().spriteList(nextWorld)
      setProjects(saved)
      update({ project: id ? saved.find(s => s.id === id) ?? newProject(nextWorld) : newProject(nextWorld), error: '', saved: '' })
      setSelected(0); setDirection(0); setTick(0); setCustom(false)
    })
  }
  async function importUri(uri: string): Promise<void> {
    const image = encodeImage(await decodeImage(uri))
    const current = session.project
    if (current) draft({ ...current, source: image })
  }
  async function importFile(file: File): Promise<void> {
    await work('Importing source…', async () => {
      if (file.size > 20 * 1024 * 1024) throw new Error('Choose an image under 20 MB.')
      const uri = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Could not read file.')); reader.readAsDataURL(file) })
      await importUri(uri)
    })
  }
  async function pick(fromWorld: boolean): Promise<void> {
    await work('Opening image…', async () => { const file = await api().falPickFile(fromWorld ? world : null, 'image'); if (file) await importUri(await api().spriteReadImage(file)) })
  }
  async function source(): Promise<void> {
    if (!p) return
    await work('Codex is creating the source (about a minute)…', async () => {
      const result = await api().spriteCodex(p, 'source', 0)
      await checkpoint({ ...p, source: result.image, generations: [...p.generations, result.generation] })
      if (result.warning) update({ error: result.warning })
    })
  }
  async function generateCodex(regenerate?: number): Promise<void> {
    if (!p) return
    await work('Generating with Codex (about a minute per call)…', async () => {
      let next = { ...p, frames: regenerate === undefined ? [] : [...p.frames] }
      await checkpoint(next)
      const targets = regenerate === undefined ? Array.from({ length: p.settings.directions }, (_, d) => d) : [p.frames[regenerate].direction]
      for (const d of targets) {
        const grid = regenerate === undefined && p.settings.method === 'grid'
        const calls = grid || regenerate !== undefined ? 1 : p.settings.count
        for (let f = 0; f < calls; f++) {
          checkStop()
          update({ busy: `Codex · ${directionLabel(d, p.settings.directions)} · ${grid ? 'pose grid' : `frame ${f + 1}/${calls}`}…` })
          const result = await api().spriteCodex(next, grid ? 'grid' : 'frame', d, regenerate ?? f)
          const images = await generatedFrames(result.image, p.settings, grid)
          const made = images.map(image => ({ id: crypto.randomUUID(), image, direction: d }))
          if (regenerate !== undefined) next.frames[regenerate] = { ...made[0], id: p.frames[regenerate].id }
          else next.frames.push(...made)
          next = { ...next, frames: [...next.frames], generations: [...next.generations, result.generation] }
          await checkpoint(next)
          if (result.warning) update({ error: result.warning })
        }
      }
    })
  }
  async function generateVideo(quote: SpriteQuote): Promise<void> {
    if (!p) return
    await work('Starting confirmed FAL pipeline…', async () => {
      let next: SpriteProject = { ...p, frames: [] }, step = 0
      await checkpoint(next)
      const paid = async (image: string, kind: 'video' | 'image') => {
        checkStop()
        update({ busy: `FAL · paid step ${step + 1}/${quote.calls} · ${kind}…` })
        const started = await api().spritePaidStep(quote.id, true, step++, image)
        next = { ...next, runIds: [...next.runIds, started.id] }; await checkpoint(next)
        const run = await waitRun(started)
        const out = run.outputs.find(o => o.kind === kind && o.mediaUrl)
        if (!out?.mediaUrl) throw new Error('FAL output could not be downloaded. Inspect it in FAL history.')
        return out.mediaUrl
      }
      try {
        const ref = await videoReference(p.source)
        for (let d = 0; d < p.settings.directions; d++) {
          const url = await paid(ref, 'video')
          checkStop(); update({ busy: 'Sampling video frames…' })
          const sampled = await sampleVideo(url, p.settings.count)
          for (const image of sampled) {
            let output = encodeImage(await decodeImage(await paid(image, 'image')))
            if (p.settings.style === 'pixel') output = encodeImage(await decodeImage(await paid(output, 'image')))
            const [normalized] = await generatedFrames(output, p.settings, false)
            next = { ...next, frames: [...next.frames, { id: crypto.randomUUID(), image: normalized, direction: d }] }
            await checkpoint(next)
          }
        }
      } finally { await api().spriteAbandon(quote.id) }
    })
  }
  async function generate(): Promise<void> {
    if (!p) return
    if (p.settings.method !== 'video') {
      if (p.frames.length) setConfirm({ title: 'Replace the current frames?', body: 'The new animation will replace this project’s frame edits. Create a new project to keep both.', action: () => generateCodex() })
      else await generateCodex()
      return
    }
    await work('Pricing the FAL pipeline…', async () => {
      const quote = await api().spriteQuote(p)
      if (!mounted.current) { await api().spriteAbandon(quote.id); return }
      setConfirm({ title: `Confirm FAL · estimated ${fmtUsd(quote.usd)}`, body: [
        `${quote.calls} paid calls: ${quote.breakdown.map(b => `${b.label}: ${b.calls} (${fmtUsd(b.usd)})`).join('; ')}.`,
        'Compute-time prices are estimates, not a final invoice. There are no automatic paid retries.',
        ...quote.reasons, p.frames.length ? 'This replaces the current frames and edits.' : ''
      ].filter(Boolean).join('\n\n'), action: () => generateVideo(quote) })
    })
  }
  async function normalize(): Promise<void> {
    if (!p) return
    await work('Aligning opaque bounds…', async () => {
      const frames = await Promise.all(p.frames.map(async f => ({ ...f, image: encodeImage(alignFrame(await decodeImage(f.image), p.settings.width, p.settings.height, p.settings.pivot)) })))
      await checkpoint({ ...p, frames })
    })
  }
  const edit = (frames: SpriteFrame[], select = selected) => { patch({ frames }); setSelected(Math.max(0, Math.min(frames.length - 1, select))) }
  const move = (delta: number) => {
    if (!p || !p.frames[selected + delta]) return
    const frames = [...p.frames]; [frames[selected], frames[selected + delta]] = [frames[selected + delta], frames[selected]]; edit(frames, selected + delta)
  }
  async function exportToWorld(toWorld: boolean): Promise<void> {
    if (!p) return
    await work('Packing the sprite sheet…', async () => {
      const directory = toWorld ? undefined : await api().pickDirectory()
      if (directory === null) return
      const sheet = encodeImage(packSheet(await Promise.all(p.frames.map(f => decodeImage(f.image))), p))
      const req = { project: p, sheet, individual, unity }
      const result = await api().spriteExport(req, directory)
      if (result.exists && mounted.current) setConfirm({ title: 'Replace existing export files?', body: result.paths.join('\n'), action: async () => {
        await work('Saving export…', async () => { const saved = await api().spriteExport({ ...req, overwrite: true }, directory); update({ saved: saved.message }) })
      } })
      else update({ saved: result.message })
    })
  }

  return <div className="view sprites-view">
    <ViewHeader kicker="Create / Animate / Export" title={<><span className="accent">Sprites</span> studio</>}>
      <select aria-label="Active world" disabled={busy} value={world ?? ''} onChange={e => {
        const w = e.target.value || null
        void work('Opening world…', async () => {
          if (p) await checkpoint(p)
          update({ project: null }); localStorage.setItem('genio.sprites.world', w ?? ''); setWorld(w); setDirection(0); setSelected(0)
        })
      }}><option value="">Scratch</option>{worlds.map(w => <option key={w.name}>{w.name}</option>)}</select>
    </ViewHeader>
    {state.error && <div role="alert" className="sprites-alert">{state.error}<button className="btn ghost sm" onClick={() => update({ error: '' })}>Dismiss</button></div>}
    <div className="sprites-project-bar">
      <select aria-label="Saved animation" disabled={busy} value={p?.id ?? ''} onChange={e => void switchProject(e.target.value)}><option value={p?.id ?? ''}>{p?.name ?? 'Loading…'}</option>{projects.filter(saved => saved.id !== p?.id).map(saved => <option key={saved.id} value={saved.id}>{saved.name}</option>)}</select>
      <button className="btn ghost sm" disabled={busy} onClick={() => void switchProject()}>New animation</button>
      <button className="btn ghost sm" disabled={busy} onClick={() => void work('Loading projects…', async () => {
        if (p) await checkpoint(p)
        setProjects(await api().spriteList(world)); setAssets(await api().spriteAssets(world))
      })}>Refresh projects</button>
      <span className="dim">{state.saved}</span>
    </div>
    {!p ? <p className="dim">Loading sprite projects…</p> : <>
      <fieldset disabled={busy} className="sprites-layout">
        <section className="panel sprites-source">
          <h2>01 / Source</h2>
          <Field label="Animation name"><input value={p.name} maxLength={60} onChange={e => patch({ name: e.target.value.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^[-_]+/, '') })} /></Field>
          <div className="sprites-drop checker" tabIndex={0} aria-label="Drop or paste a source image" onDragOver={e => e.preventDefault()} onDrop={e => {
            e.preventDefault(); if (!busy && e.dataTransfer.files[0]) void importFile(e.dataTransfer.files[0])
          }}>
            {p.source ? <img src={p.source} alt="Animation source" /> : <span><Film size={32} /><br />Drop an image or paste from clipboard</span>}
          </div>
          <div className="sprites-actions"><button className="btn sm" onClick={() => void pick(false)}><FolderOpen size={14} />Local image</button><button className="btn sm" disabled={!world} onClick={() => void pick(true)}>World file</button></div>
          <Field label="Earlier chat / FAL image"><select value="" onChange={e => { const file = e.target.value; if (file) void work('Importing image…', async () => importUri(await api().spriteReadImage(file))) }}><option value="">Choose an earlier image…</option>{assets.map((a, i) => <option key={i} value={a.path}>{a.label}</option>)}</select></Field>
          <Field label="Character and motion notes"><textarea rows={4} value={p.prompt} placeholder="A small armoured fox with a blue cape…" onChange={e => patch({ prompt: e.target.value })} maxLength={3000} /></Field>
          <button className="btn" disabled={p.prompt.trim().length < 3} onClick={() => void source()}><Sparkles size={14} />Generate source · Codex</button>
          <p className="dim">Uses your ChatGPT plan. About a minute per image.</p>
        </section>
        <section className="panel sprites-setup">
          <h2>02 / Animation</h2>
          <div className="sprites-fields">
            <Field label="Action"><select value={custom || !SPRITE_PRESETS.includes(p.settings.animation) ? 'custom' : p.settings.animation} onChange={e => { setCustom(e.target.value === 'custom'); settings({ animation: e.target.value }) }}>{SPRITE_PRESETS.map(a => <option key={a}>{a}</option>)}</select></Field>
            <Field label="Frames per direction"><input type="number" min={1} max={16} value={p.settings.count} onChange={e => settings({ count: Math.max(1, Math.min(16, Number(e.target.value))) })} /></Field>
            {(custom || !SPRITE_PRESETS.includes(p.settings.animation) || p.settings.animation === 'custom') && <Field label="Custom action" wide><input value={p.settings.animation === 'custom' ? '' : p.settings.animation} onChange={e => settings({ animation: e.target.value })} placeholder="Cast a spell" maxLength={500} /></Field>}
            <Field label="Cell width"><input type="number" min={8} max={1024} value={p.settings.width} onChange={e => settings({ width: Math.max(8, Math.min(1024, Number(e.target.value))) })} /></Field>
            <Field label="Cell height"><input type="number" min={8} max={1024} value={p.settings.height} onChange={e => settings({ height: Math.max(8, Math.min(1024, Number(e.target.value))) })} /></Field>
            <Field label="Directions"><select disabled={!!p.frames.length} title={p.frames.length ? 'Start a new animation to change directions.' : ''} value={p.settings.directions} onChange={e => { settings({ directions: Number(e.target.value) as 1 | 4 | 8 }); setDirection(0) }}>{[1, 4, 8].map(n => <option key={n} value={n}>{n}</option>)}</select></Field>
            <Field label="FPS"><input type="number" min={1} max={60} value={p.settings.fps} onChange={e => settings({ fps: Math.max(1, Math.min(60, Number(e.target.value))) })} /></Field>
            <Field label="Playback"><select value={p.settings.playback} onChange={e => settings({ playback: e.target.value as SpriteSettings['playback'] })}><option value="loop">Loop</option><option value="ping-pong">Ping-pong</option></select></Field>
            <Field label="Style"><select value={p.settings.style} onChange={e => settings({ style: e.target.value as SpriteSettings['style'] })}><option value="pixel">Pixel art</option><option value="hd">HD</option></select></Field>
            {p.settings.style === 'pixel' && <>
              <Field label="Palette colors"><input type="number" min={1} max={256} value={p.settings.colors} onChange={e => settings({ colors: Math.max(1, Math.min(256, Number(e.target.value))) })} /></Field>
              <Field label="Pixel scale (FAL)"><input type="number" min={1} max={64} value={p.settings.pixelScale} onChange={e => settings({ pixelScale: Math.max(1, Math.min(64, Number(e.target.value))) })} /></Field>
              <Field label="Fixed palette (optional hex colors)" wide><input value={p.settings.palette} placeholder="#182030, #f0d090, #70a0c0" onChange={e => settings({ palette: e.target.value })} /></Field>
            </>}
            <Field label="Generation method" wide><select value={p.settings.method} onChange={e => settings({ method: e.target.value as SpriteSettings['method'] })}><option value="grid">Codex frames · one grid per direction</option><option value="frames">Codex frames · frame by frame</option><option value="video">Video → frames · FAL (paid)</option></select></Field>
          </div>
          <p className="dim">{p.settings.method === 'grid' ? 'A shared grid keeps poses, scale and palette together. The grid is sliced automatically; inspect cell boundaries after generation.' : p.settings.method === 'frames' ? 'Each frame uses the source and adjacent completed poses as references. About a minute per frame.' : '4-second video per direction → sample frames → remove backgrounds → optional pixel conversion. Review the full estimated cost first.'}</p>
          <button className="btn solid" disabled={!p.source || !p.name || !p.settings.animation.trim()} onClick={() => void generate()}><Play size={14} />{p.settings.method === 'video' ? 'Review cost & generate' : 'Generate animation'}</button>
        </section>
        <section className="panel sprites-preview">
          <h2>03 / Preview</h2>
          <div className={'sprites-stage checker ' + (p.settings.style === 'pixel' ? 'pixel-art' : '')} style={{ aspectRatio: `${p.settings.width} / ${p.settings.height}` }}>
            {onion && prev && <img className="onion" src={prev.image} alt="Previous pose onion skin" />}
            {current ? <img src={current.image} alt="Animated preview" /> : <span className="dim">Your animation appears here</span>}
            <i className="sprites-pivot" style={{ left: `${p.settings.pivot.x * 100}%`, top: `${p.settings.pivot.y * 100}%` }} />
          </div>
          <div className="sprites-actions"><button className="btn sm" onClick={() => setPlaying(v => !v)}>{playing ? 'Pause' : 'Play'}</button><label><input type="checkbox" checked={onion} onChange={e => setOnion(e.target.checked)} /> Onion skin</label></div>
          <Field label="Preview direction"><select value={direction} onChange={e => { setDirection(Number(e.target.value)); setTick(0); setPlaying(true) }}>{Array.from({ length: p.settings.directions }, (_, i) => <option key={i} value={i}>{directionLabel(i, p.settings.directions)}</option>)}</select></Field>
          <p className="dim">{alpha}</p>
          <div className="sprites-fields">
            <Field label="Pivot X (0–1)"><input type="number" min={0} max={1} step={0.05} value={p.settings.pivot.x} onChange={e => settings({ pivot: { ...p.settings.pivot, x: Math.max(0, Math.min(1, Number(e.target.value))) } })} /></Field>
            <Field label="Pivot Y (0–1)"><input type="number" min={0} max={1} step={0.05} value={p.settings.pivot.y} onChange={e => settings({ pivot: { ...p.settings.pivot, y: Math.max(0, Math.min(1, Number(e.target.value))) } })} /></Field>
          </div>
          <button className="btn sm" disabled={!p.frames.length} onClick={() => void normalize()}>Auto-align, trim & pad</button>
          <p className="dim">Aligns the bottom-centre of opaque bounds to the pivot. Increase the cell size if a pose would be clipped.</p>
        </section>
      </fieldset>
      <section className="panel sprites-editor">
        <div className="sprites-actions"><h2>Frames <span className="dim">/ {p.frames.length}</span></h2><span className="dim">Select a pose to edit</span></div>
        <div className="sprites-strip">{p.frames.map((f, i) => <button key={f.id} className={`sprites-frame ${selected === i ? 'selected' : ''}`} onClick={() => { setSelected(i); setDirection(f.direction); setPlaying(false) }}><img className="checker pixel-art" src={f.image} alt={`Frame ${i + 1}`} /><span>{i + 1} · {directionLabel(f.direction, p.settings.directions)}</span></button>)}</div>
        {!p.frames.length && <p className="dim">Generate an animation to build the frame strip.</p>}
        <div className="sprites-actions">
          <button className="btn sm" disabled={busy || selected <= 0} onClick={() => move(-1)}>← Earlier</button>
          <button className="btn sm" disabled={busy || selected >= p.frames.length - 1} onClick={() => move(1)}>Later →</button>
          <button className="btn sm" disabled={busy || !p.frames[selected] || p.frames.length >= 128} onClick={() => { const frames = [...p.frames]; frames.splice(selected + 1, 0, { ...frames[selected], id: crypto.randomUUID() }); edit(frames, selected + 1) }}>Duplicate</button>
          <button className="btn sm" disabled={busy || !p.frames[selected]} onClick={() => edit(p.frames.filter((_, i) => i !== selected))}>Delete</button>
          <button className="btn sm" disabled={busy || !p.frames[selected] || !p.source} onClick={() => void generateCodex(selected)}>Regenerate pose · Codex</button>
          <button className="btn sm" disabled={busy || !p.source || p.frames.length >= 128} onClick={() => void work('Adding source as a frame…', async () => {
            const [image] = await generatedFrames(p.source, p.settings, false); edit([...p.frames, { id: crypto.randomUUID(), image, direction }], p.frames.length)
          })}>Add source as frame</button>
        </div>
      </section>
      <fieldset disabled={busy || !p.frames.length} className="panel sprites-export">
        <h2>04 / Export</h2>
        <Field label="Columns"><input type="number" min={1} max={128} value={p.settings.columns} onChange={e => settings({ columns: Math.max(1, Math.min(128, Number(e.target.value))) })} /></Field>
        <Field label="Cell padding"><input type="number" min={0} max={64} value={p.settings.padding} onChange={e => settings({ padding: Math.max(0, Math.min(64, Number(e.target.value))) })} /></Field>
        <label><input type="checkbox" checked={unity} onChange={e => setUnity(e.target.checked)} /> Unity metadata</label>
        <label><input type="checkbox" checked={individual} onChange={e => setIndividual(e.target.checked)} /> Individual PNGs</label>
        <button className="btn" onClick={() => void exportToWorld(false)}>Export PNG + JSON…</button>
        <button className="btn solid" disabled={!world} onClick={() => void exportToWorld(true)}><Save size={14} />Save to world</button>
      </fieldset>
      <p className="dim">Projects save automatically in Genio per world. World exports include provenance and FAL spend, remain uncommitted, and ask before replacing files.</p>
    </>}
    {busy && <div className="sprites-progress" role="status"><span>{state.busy}</span><button className="btn sm" onClick={() => { cancelled = true; update({ busy: 'Stopping after the current call…' }) }}>Stop after current call</button></div>}
    {confirm && <Confirm title={confirm.title} body={<div style={{ whiteSpace: 'pre-wrap' }}>{confirm.body}</div>} confirmLabel="Confirm" onClose={() => setConfirm(null)} onConfirm={async () => { const run = confirm.action; setConfirm(null); await run() }} />}
  </div>
}
