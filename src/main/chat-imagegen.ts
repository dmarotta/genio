/**
 * generate_image for Genio's chats (main and allies, never the Bot): Codex's
 * built-in image_gen on the player's ChatGPT plan, run through the bundled
 * codex-image helper outside any world (scratch under Genio's data). The PNGs
 * are stored as chat images of that chat and posted there as a Genio message
 * (a "generating" placeholder first, resolved in place into the images or an
 * error); the tool result hands them back to the model as image blocks.
 * Chat images stay chat-only: nothing is written into a world.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { bus } from './bus'
import path from 'node:path'
import { z } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { MAX_IMAGE_BYTES, validChatImageFile, type ChatImage } from '@shared/chat-images'
import type { ChatMessage } from '@shared/types'
import { chatImageDir, chatImagePath } from './chat-images'
import type { AppCtx } from './services'
import type { Home } from './home'
import { codexImageScratch, codexImageSkillDir, installUnitPlugin, unitPluginDir, unitPluginSource } from './unitskills'
import { ensureDir, nowIso, rid, truncate } from './util'

export const MAX_GENERATED = 4
export const MAX_REFS = 8
/** plan meter % at which the chat message warns */
export const METER_WARN_AT = 80
export const LOGIN_HINT = 'log in to Codex in Systems → Accounts'

export const GENERATE_IMAGE_DESC =
  "Generate PNG image(s) with Codex's image_gen on the player's ChatGPT plan (no API cost; about a minute per call) and show them in this chat. " +
  'Use for concepts, sprites, icons, transparent cutouts, and edits or variations of an image: pass refs = chat image ids (shown as [attached image ids: ...] on pasted screenshots and returned by earlier generate_image calls) or absolute paths. ' +
  'You get the images back to judge them, plus the plan meter. For world assets pass world, place from asset_locate, and player_words. Runs in the background; use generation_status to inspect completion. Without a world it stays in chat.'

export const generateImageShape = {
  prompt: z.string().min(3).max(4000),
  transparent: z.boolean().default(false),
  refs: z.array(z.string().min(1)).max(MAX_REFS).default([]),
  world: z.string().optional(),
  place: z.string().optional(),
  player_words: z.string().trim().min(1).optional(),
  count: z.number().int().min(1).max(MAX_GENERATED).default(1)
}
export type GenerateImageArgs = z.infer<z.ZodObject<typeof generateImageShape>>

const ok = (content: CallToolResult['content']): CallToolResult => ({ content })
const fail = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true })

/** The tail of a player prompt that names its attached images, so Genio can pass them as refs. */
export function attachedIdsNote(images: readonly ChatImage[]): string {
  return images.length ? `\n\n[attached image ids: ${images.map((i) => i.file).join(', ')}]` : ''
}

/** Refs to files: a chat image id of this chat, or an absolute path to an existing image. */
export function resolveRefs(chatDir: string, refs: readonly string[]): string[] {
  return refs.map((raw) => {
    const ref = raw.trim()
    if (validChatImageFile(ref)) {
      const p = chatImagePath(chatDir, ref)
      if (!p) throw new Error(`No chat image "${ref}" in this chat.`)
      return p
    }
    if (!path.isAbsolute(ref)) throw new Error(`Reference "${ref}" is neither a chat image id nor an absolute path.`)
    if (!/\.(png|jpe?g|webp|gif)$/i.test(ref)) throw new Error(`${ref}: references must be PNG, JPEG, WebP or GIF images.`)
    if (!fs.statSync(ref, { throwIfNoEntry: false })?.isFile()) throw new Error(`Reference image not found: ${ref}`)
    return ref
  })
}

/** Width and height from a PNG's IHDR, when the bytes are a PNG. */
export function pngSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') return undefined
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** A short, actionable message for a failed helper run. */
export function friendlyError(msg: string): string {
  if (/not found on PATH|Could not start Codex|without a shell/i.test(msg)) return `Codex is not installed or not on PATH: install the Codex CLI, then ${LOGIN_HINT}.`
  if (/not logged in|log ?in|unauthori[sz]ed|\b401\b|no thread id|No session rollout/i.test(msg)) return `Codex could not run (is it logged in?): ${LOGIN_HINT}. (${truncate(msg, 200)})`
  if (/made no image/i.test(msg)) return 'Codex finished but made no image (it may have declined the prompt). Try rephrasing.'
  return truncate(msg, 400)
}

/** How to run the helper: its script, the scratch folder under Genio's data, and extra env (tests). */
export interface CodexImageRun {
  script: string
  scratch: string
  env?: Record<string, string | undefined>
}

interface HelperImage {
  out: string
  ok: boolean
  error?: string
  revised_prompt?: string
}
export interface HelperResult {
  images: HelperImage[]
  plan_meter?: { known?: boolean; used_percent?: number | null; warning?: string | null }
  warning?: string | null
}

/** Run codex-image.mjs --no-world; resolves with its JSON, or an error message. */
export function runCodexImage(run: CodexImageRun, outs: readonly string[], prompt: string, transparent: boolean, refs: readonly string[]): Promise<{ result?: HelperResult; error?: string }> {
  const args = [run.script, '--no-world', '--warn-at', String(METER_WARN_AT), ...outs.flatMap((o) => ['--prompt', prompt, '--out', o]), ...(transparent ? ['--transparent'] : []), ...refs.flatMap((r) => ['--ref', r])]
  // Electron's own binary runs the helper as plain Node
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', GENIO_CODEX_IMAGE_SCRATCH: run.scratch }
  delete env.FAL_KEY
  for (const [k, v] of Object.entries(run.env ?? {})) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: run.scratch, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (e) => resolve({ error: `Could not start the image helper (${e.message}).` }))
    child.on('close', (code) => {
      try {
        if (stdout.trim()) return resolve({ result: JSON.parse(stdout) as HelperResult })
      } catch {
        /* fall through to stderr */
      }
      const tail = stderr.match(/\{\s*"error"[\s\S]*$/)?.[0]
      let msg = ''
      try {
        msg = tail ? String((JSON.parse(tail) as { error?: unknown }).error ?? '') : ''
      } catch {
        /* not JSON */
      }
      resolve({ error: msg || `the image helper exited with code ${code}${stderr.trim() ? `: ${truncate(stderr.trim(), 300)}` : ''}` })
    })
  })
}

/** Where a chat's generate_image runs and posts. */
export interface ChatImageGen {
  /** this chat's image folder (data/chat-images of its base) */
  chatDir: string
  wksp: string
  /** upsert a message in this chat; persist=false for the transient placeholder */
  post(m: ChatMessage, persist: boolean): void
  run: CodexImageRun
}

/** The generate_image wiring for one base: the installed helper (refreshed from the app) and Genio's data scratch. */
export function chatImageGen(ctx: AppCtx, home: Home): ChatImageGen {
  const main = ctx.main.home
  const plugin = installUnitPlugin(unitPluginSource(ctx.appRoot), unitPluginDir(main.root), ctx.projects.list().map((p) => p.path))
  const scratch = codexImageScratch(main.data)
  return {
    chatDir: chatImageDir(home.data),
    wksp: home.name,
    post: (m, persist) => ctx.home(home.name).wksp.post(m, persist),
    run: { script: path.join(codexImageSkillDir(plugin), 'scripts', 'codex-image.mjs'), scratch }
  }
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`

/** The generate_image tool: placeholder → helper run → images in the chat and back to the model. */
export async function generateChatImages(gen: ChatImageGen, a: GenerateImageArgs): Promise<CallToolResult> {
  const prompt = a.prompt.trim()
  if (prompt.length < 3) return fail('generate_image needs a prompt.')
  const count = Math.min(MAX_GENERATED, Math.max(1, Math.floor(a.count ?? 1)))
  let refs: string[]
  try {
    refs = resolveRefs(gen.chatDir, a.refs ?? [])
  } catch (e) {
    return fail((e as Error).message)
  }

  const id = `g-${rid(6)}`
  const base: ChatMessage = { id, wksp: gen.wksp, role: 'genio', text: '', ts: nowIso() }
  gen.post({ ...base, text: `Generating ${count === 1 ? 'image' : plural(count, 'image')}… (about a minute on your ChatGPT plan)`, generating: count }, false)
  const failed = (msg: string): CallToolResult => {
    const why = friendlyError(msg)
    gen.post({ ...base, role: 'error', text: `Image generation failed: ${why}` }, true)
    return fail(`generate_image failed: ${why}`)
  }

  ensureDir(gen.chatDir)
  ensureDir(gen.run.scratch)
  const outs = Array.from({ length: count }, () => path.join(gen.chatDir, `${Date.now().toString(36)}-${rid(4)}.png`))
  const { result, error } = await runCodexImage(gen.run, outs, prompt, !!a.transparent, refs)
  if (!result) return failed(error ?? 'the image helper gave no result')

  const made: { ref: ChatImage; bytes: Buffer; revised?: string }[] = []
  const errors: string[] = []
  for (const im of result.images ?? []) {
    const bytes = im.ok && fs.existsSync(im.out) ? fs.readFileSync(im.out) : undefined
    if (!bytes) {
      errors.push(im.error ?? 'missing image')
      continue
    }
    made.push({ ref: { file: path.basename(im.out), mediaType: 'image/png', ...pngSize(bytes) }, bytes, revised: im.revised_prompt })
  }
  if (!made.length) return failed(errors[0] ?? 'Codex made no image.')

  const used = result.plan_meter?.used_percent
  const warn = typeof used === 'number' && used >= METER_WARN_AT
  const revised = [...new Set(made.map((m) => m.revised).filter(Boolean))]
  const lines = [
    `**Generated ${plural(made.length, 'image')}**${a.transparent ? ' · transparent' : ''}${refs.length ? ` · from ${plural(refs.length, 'reference')}` : ''}`,
    ...revised.map((r) => `> ${truncate(r!.replace(/\s+/g, ' '), 600)}`),
    errors.length ? `${plural(errors.length, 'image')} failed: ${friendlyError(errors[0])}` : '',
    warn ? `⚠ Your ChatGPT plan meter is at ${used}%: images share that allowance with your Codex units.` : result.warning ? `⚠ ${result.warning}` : ''
  ]
  gen.post({ ...base, text: lines.filter(Boolean).join('\n\n'), images: made.map((m) => m.ref) }, true)
  bus.publish({ type: 'feature-used', feature: 'chat-image', id: base.id, count: made.length })

  const summary = {
    posted_in_chat: true,
    images: made.map((m) => ({ id: m.ref.file, width: m.ref.width, height: m.ref.height, revised_prompt: m.revised })),
    failed: errors.length ? errors : undefined,
    plan_meter_percent: typeof used === 'number' ? used : null,
    warning: warn ? `ChatGPT plan meter at ${used}%` : (result.warning ?? undefined),
    note: 'Pass these ids as refs to edit or vary them. Chat-only: nothing was saved into a world.'
  }
  const blocks: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(summary, null, 1) }]
  for (const m of made) {
    if (m.bytes.length <= MAX_IMAGE_BYTES) blocks.push({ type: 'image', data: m.bytes.toString('base64'), mimeType: 'image/png' })
    else blocks.push({ type: 'text', text: `${m.ref.file} is too large to attach here; it is in the chat.` })
  }
  return ok(blocks)
}
