/**
 * Skills Genio bundles for its units (FAL.ai, Codex images on the ChatGPT
 * plan). The source lives in resources/unit-skills/genio, laid out as a Claude
 * Code plugin. At launch it is installed into the main base's skills/ folder,
 * never into a world: Claude Code units load it with --plugin-dir, every
 * runtime gets the SKILL.md paths in its brief and as GENIO_FAL_SKILL,
 * GENIO_IMAGEGEN_CODEX_SKILL and the like, and the genio-unity wrapper as
 * GENIO_UNITY. The FAL key reaches a unit only as the FAL_KEY
 * environment variable of its process.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, fwd, isSubPath } from './util'

export const UNIT_PLUGIN = 'genio'
const SKILL_DIR_TOKEN = /\{\{SKILL_DIR\}\}/g
/** Skills an earlier install left behind: the Play helper is now internal to genio-unity. */
const RETIRED = ['skills/play/SKILL.md']

export const unitPluginSource = (appRoot: string): string => path.join(appRoot, 'resources', 'unit-skills', UNIT_PLUGIN)
export const unitPluginDir = (homeRoot: string): string => path.join(homeRoot, 'skills', UNIT_PLUGIN)
export const assetsSkillDir = (pluginDir: string): string => path.join(pluginDir, 'skills', 'assets')
export const uthanaSkillDir = (pluginDir: string): string => path.join(pluginDir, 'skills', 'uthana')
export const falSkillDir = (pluginDir: string): string => path.join(pluginDir, 'skills', 'fal')
export const blenderSkillDir = (pluginDir: string): string => path.join(pluginDir, 'skills', 'blender')
export const codexImageSkillDir = (pluginDir: string): string => path.join(pluginDir, 'skills', 'imagegen-codex')
export const unitySkillDir = (pluginDir: string): string => path.join(pluginDir, 'skills', 'unity')
/** The genio-unity wrapper: the only way a unit drives Unity. */
export const genioUnityScript = (pluginDir: string): string => path.join(unitySkillDir(pluginDir), 'scripts', 'genio-unity.mjs')
/** The Modeller kernel CLI (steps, revert, branch) on the safe Blender runner. */
export const modellerScript = (pluginDir: string): string => path.join(blenderSkillDir(pluginDir), 'scripts', 'modeller.mjs')
/** A Modeller's steps, snapshots and review sheets: the unit's data folder, never its worktree. */
export const modellerDataDir = (taskDataDir: string): string => path.join(taskDataDir, 'modeller')
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
      throw new Error(`Refusing to install unit skills at ${target}: it overlaps the project at ${w}.`)
    }
  }
  if (!fs.existsSync(path.join(source, '.claude-plugin', 'plugin.json'))) throw new Error(`Bundled unit skills are missing at ${source}.`)
  copyTree(source, target)
  for (const file of RETIRED) fs.rmSync(path.join(target, file), { force: true })
  return target
}

export interface UnitLaunchExtras {
  /** Prepended to the runtime's argv. */
  args: string[]
  env: Record<string, string>
}

/** Launch additions for a unit: the plugin dir for Claude Code, the skill paths, Codex image scratch and the FAL key for all. */
export function unitLaunchExtras(harnessId: string, opts: { pluginDir?: string; falKey?: string; dataDir?: string; taskDataDir?: string }): UnitLaunchExtras {
  const args: string[] = []
  const env: Record<string, string> = {}
  if (opts.pluginDir) {
    // First in argv: the next element is always another flag, never the prompt.
    if (harnessId === 'claude') args.push('--plugin-dir', opts.pluginDir)
    env.GENIO_BLENDER_SKILL = fwd(blenderSkillDir(opts.pluginDir))
    if (opts.taskDataDir ?? opts.dataDir) env.GENIO_BLENDER_SCRATCH = fwd(path.join((opts.taskDataDir ?? opts.dataDir)!, 'blender'))
    if (opts.taskDataDir) env.GENIO_MODELLER_DATA = fwd(modellerDataDir(opts.taskDataDir))
    env.GENIO_ASSETS_SKILL = fwd(assetsSkillDir(opts.pluginDir))
    env.GENIO_UNITY_SKILL = fwd(unitySkillDir(opts.pluginDir))
    env.GENIO_UNITY = fwd(genioUnityScript(opts.pluginDir))
    env.GENIO_UTHANA_SKILL = fwd(uthanaSkillDir(opts.pluginDir))
    env.GENIO_FAL_SKILL = fwd(falSkillDir(opts.pluginDir))
    env.GENIO_IMAGEGEN_CODEX_SKILL = fwd(codexImageSkillDir(opts.pluginDir))
    if (opts.dataDir) env.GENIO_CODEX_IMAGE_SCRATCH = fwd(codexImageScratch(opts.dataDir))
  }
  const key = opts.falKey?.trim()
  if (key) env.FAL_KEY = key
  return { args, env }
}

/**
 * The OpenRouter key reaches a unit only as OPENROUTER_API_KEY in its process
 * environment, only for OpenCode, and only in a world that allows cheap
 * third-party models.
 */
export function openRouterEnv(harnessId: string, worldAllows: boolean, key: string | undefined): Record<string, string> {
  const k = key?.trim()
  return harnessId === 'opencode' && worldAllows && k ? { OPENROUTER_API_KEY: k } : {}
}

/** The brief addition for a Modeller unit: how to work in small, reviewed Blender steps. */
export function modellerBrief(pluginDir: string, taskDataDir: string): string {
  const skill = fwd(blenderSkillDir(pluginDir))
  const kernel = fwd(modellerScript(pluginDir))
  const data = fwd(modellerDataDir(taskDataDir))
  return [
    `You are a Modeller: you build a 3D model in small steps that the player watches live. Read \`${skill}/SKILL.md\`, section "Modeller steps", before the first step. Every kind of model is in scope.`,
    '- You write Python (bpy) step scripts; Genio runs each in its own headless Blender. There is no MCP and no live Blender session.',
    `- Start each model once: \`node "${kernel}" init <model> --target <unity|godot|web>\` (add \`--budget <triangles>\` or \`--size <x>x<y>x<z>\` when the mission gives them). Run a batch of steps: \`node "${kernel}" batch <model> <script.py> <script.py>...\` (or a folder of them); run one step: \`node "${kernel}" step <model> <script.py>\`.`,
    '- One step is one idea (legs, bracing, deck, roof) with 3 to 15 named parts. Put step scripts in your worktree under `.genio/modeller/<model>/`, numbered `s01_legs.py`, `s02_bracing.py`. The first line of each script is a one-line docstring caption in plain words ("Now adding the roof: corner posts and shingles"): the player reads it live as that step lands. Build with the preloaded `p` helpers so a script can run again without duplicating parts.',
    '- Block the model out in batches of 3 to 6 steps (body, wheels, wings, cockpit): write the scripts, then run them as one batch. Each lands in the live view as Blender finishes it, every second or so, and stays a normal step for revert and branch. Use single steps for fixes and fine details.',
    '- After every batch or step, open the review sheet PNG it prints (3/4, front, side and top views of the last step) and read its warnings. Fix what is wrong before adding anything new: a fix is its own step, or `--amend` the last one. A batch stops at a failing script: the steps before it stay, and the JSON lists the scripts that did not run.',
    '- The warnings and checks are information for you and the player, never a gate. You decide when the model is done; then deliver it as the Modeller delivery under Definition of done says, like any Build.',
    '- Steering ("steeper roof") becomes the next step. `revert <model> <step>` or `branch <model> <name> --from <step>` goes back to an earlier version; `status <model>` lists the steps.',
    `- Steps, .blend snapshots, GLBs and review sheets live in \`${data}/\` (GENIO_MODELLER_DATA). Never copy them into the worktree or commit them, except what the Modeller delivery under Definition of done names for the finished model.`,
    '- A failed, crashed or hung step leaves the model at its last good step. Read the error and trace it prints, fix the script and run it again; do not retry it unchanged.'
  ].join('\n')
}

/** The brief's pointer to the bundled skills. Paths only; never a key. */
export function unitToolsBrief(pluginDir: string): string {
  const assets = fwd(assetsSkillDir(pluginDir))
  const uthana = fwd(uthanaSkillDir(pluginDir))
  const dir = fwd(falSkillDir(pluginDir))
  const codex = fwd(codexImageSkillDir(pluginDir))
  const blender = fwd(blenderSkillDir(pluginDir))
  const unity = fwd(unitySkillDir(pluginDir))
  return (
    `- Unity (Unity projects only): read \`${unity}/SKILL.md\`. Compile, test, import, build, play, send editor commands and read the console only with \`node "${unity}/scripts/genio-unity.mjs" <verb>\` (also in GENIO_UNITY). It targets only your own copy or your leased Play slot. Never start Unity.exe, Unity Hub or the \`unity\` CLI yourself, never control the main editor and never touch Toolbox.\n` +
    `- Assets: read \`${assets}/SKILL.md\` first for provider routing and project-type placement. Use asset_locate / the shared suggestLocation helper. Uthana motions use Genio tools described in \`${uthana}/SKILL.md\`; units have no Uthana CLI.\n` +
    `- Blender (batch modelling, validation, export and conversion): read \`${blender}/SKILL.md\` and use \`node "${blender}/scripts/blender.mjs"\`. Requires local Blender; no MCP or live session. Logs go to GENIO_BLENDER_SCRATCH.\n` +
    `- Images (default): Codex images on the player's ChatGPT plan, on in every project unless it opted out. For concept art, sprites, icons, transparent cutouts and edits from references read \`${codex}/SKILL.md\` and use \`node "${codex}/scripts/codex-image.mjs"\`.\n` +
    `- FAL.ai (specific needs: seamless/PBR textures, 3D, audio, music, video, pixel-art conversion, upscaling, background removal, exact size/seed/reproducibility): before any FAL work read \`${dir}/SKILL.md\` and use its helper \`node "${dir}/scripts/fal.mjs"\`. ` +
    'Every model run is a paid call: the USD budget stated in this brief or a ping is a hard stop; pass it as --budget and report what you spent. ' +
    'The key, when the player set one, is only in your FAL_KEY environment variable: never print or write it. ' +
    "Generate with --world <your worktree root>: it follows the project's .genio/fal/ config and recipes and records provenance and spend lines in .genio/, which you commit with the assets; never edit .genio/fal/config.json or recipes.json."
  )
}
