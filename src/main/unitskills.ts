/**
 * Skills Genio bundles for its units (FAL.ai, Codex images on the ChatGPT
 * plan). The source lives in resources/unit-skills/genio, laid out as a Claude
 * Code plugin. At launch it is installed into the main base's skills/ folder,
 * never into a world: Claude Code units load it with --plugin-dir, every
 * runtime gets the SKILL.md paths in its brief and as GENIO_FAL_SKILL and
 * GENIO_IMAGEGEN_CODEX_SKILL. The FAL key reaches a unit only as the FAL_KEY
 * environment variable of its process.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, fwd, isSubPath } from './util'

export const UNIT_PLUGIN = 'genio'
const SKILL_DIR_TOKEN = /\{\{SKILL_DIR\}\}/g

export const unitPluginSource = (appRoot: string): string => path.join(appRoot, 'resources', 'unit-skills', UNIT_PLUGIN)
export const unitPluginDir = (homeRoot: string): string => path.join(homeRoot, 'skills', UNIT_PLUGIN)
export const falSkillDir = (pluginDir: string): string => path.join(pluginDir, 'skills', 'fal')
export const codexImageSkillDir = (pluginDir: string): string => path.join(pluginDir, 'skills', 'imagegen-codex')
/** Scratch runs of the Codex image helper live in Genio's data, never in a world. */
export const codexImageScratch = (dataDir: string): string => path.join(dataDir, 'codex-image')

function writeIfChanged(file: string, content: Buffer): void {
  try {
    if (fs.readFileSync(file).equals(content)) return
  } catch {
    /* new file */
  }
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, content)
}

function copyTree(src: string, dest: string): void {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name)
    const to = path.join(dest, e.name)
    if (e.isDirectory()) {
      copyTree(from, to)
    } else if (e.isFile()) {
      const raw = fs.readFileSync(from)
      // SKILL.md files name their own folder so any runtime can follow the paths.
      const out = e.name.endsWith('.md') ? Buffer.from(raw.toString('utf8').replace(SKILL_DIR_TOKEN, fwd(dest)), 'utf8') : raw
      writeIfChanged(to, out)
    }
  }
}

/**
 * Install (or refresh) the bundled plugin at `target`. Refuses a target inside
 * any of `worlds` (clones and worktrees): skills never land in a world's tree.
 */
export function installUnitPlugin(source: string, target: string, worlds: string[]): string {
  for (const w of worlds) {
    if (w && (isSubPath(target, w) || isSubPath(w, target))) {
      throw new Error(`Refusing to install unit skills at ${target}: it overlaps the world at ${w}.`)
    }
  }
  if (!fs.existsSync(path.join(source, '.claude-plugin', 'plugin.json'))) throw new Error(`Bundled unit skills are missing at ${source}.`)
  copyTree(source, target)
  return target
}

export interface UnitLaunchExtras {
  /** Prepended to the runtime's argv. */
  args: string[]
  env: Record<string, string>
}

/** Launch additions for a unit: the plugin dir for Claude Code, the skill paths, Codex image scratch and the FAL key for all. */
export function unitLaunchExtras(harnessId: string, opts: { pluginDir?: string; falKey?: string; dataDir?: string }): UnitLaunchExtras {
  const args: string[] = []
  const env: Record<string, string> = {}
  if (opts.pluginDir) {
    // First in argv: the next element is always another flag, never the prompt.
    if (harnessId === 'claude') args.push('--plugin-dir', opts.pluginDir)
    env.GENIO_FAL_SKILL = fwd(falSkillDir(opts.pluginDir))
    env.GENIO_IMAGEGEN_CODEX_SKILL = fwd(codexImageSkillDir(opts.pluginDir))
    if (opts.dataDir) env.GENIO_CODEX_IMAGE_SCRATCH = fwd(codexImageScratch(opts.dataDir))
  }
  const key = opts.falKey?.trim()
  if (key) env.FAL_KEY = key
  return { args, env }
}

/** The brief's pointer to the bundled skills. Paths only; never a key. */
export function unitToolsBrief(pluginDir: string): string {
  const dir = fwd(falSkillDir(pluginDir))
  const codex = fwd(codexImageSkillDir(pluginDir))
  return (
    `- FAL.ai (generative images, audio, music, video, 3D): before any FAL work read \`${dir}/SKILL.md\` and use its helper \`node "${dir}/scripts/fal.mjs"\`. ` +
    'Every model run is a paid call: the USD budget stated in this brief or a ping is a hard stop; pass it as --budget and report what you spent. ' +
    'The key, when the player set one, is only in your FAL_KEY environment variable: never print or write it. ' +
    "Generate with --world <your worktree root>: it follows the world's .genio/fal/ config and recipes and records provenance and spend lines in .genio/, which you commit with the assets; never edit .genio/fal/config.json or recipes.json.\n" +
    `- Codex images (uses your ChatGPT plan, not FAL credit): only when the world enabled it in .genio/fal/config.json or the mission asks for it, read \`${codex}/SKILL.md\` and use \`node "${codex}/scripts/codex-image.mjs"\`.`
  )
}
