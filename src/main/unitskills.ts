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
export const soundSkillDir = (pluginDir: string): string => path.join(pluginDir, 'skills', 'sound')
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

/**
 * The Modeller helper API in about 2 KB, so a unit starts without reading the Python sources.
 * The blender SKILL.md carries the same lines (a test keeps them in step).
 */
export const MODELLER_API_CARD = [
  '**API card** (enough to start: never read `genio_step.py`, `genio_parts.py` or `modeller.mjs`):',
  '- A step script runs in headless Blender on the previous step\'s scene with `bpy` and the helpers `p` preloaded (do not import them; `math` and `mathutils` may be imported). Line 1 is a one-line docstring caption in plain words; the player reads it live as the step lands.',
  '- Metres, Z up, the model stands on z = 0 with its footprint centred on the origin and its front facing -Y (its left side is +X).',
  '- A part made again under the same name replaces the old one, so a script can run twice. Part helpers return the object and take `mat=` and `col=`; `rot` is Euler radians.',
  '- Parts: `p.box(name, (sx, sy, sz), loc, rot, mat, bevel=0.0)` centred on loc; `p.cylinder(name, radius, depth, loc, rot, mat, segments=16, radius_top=None)` along local Z; `p.cone(name, radius, depth, loc, rot, mat)`; `p.sphere(name, radius, loc, mat, subdiv=2)`; `p.beam(name, a, b, thickness, mat)` from point a to b; `p.prism(name, [(x, y), ...], depth, loc, rot, mat)` counter-clockwise outline extruded along local Z; `p.lathe(name, [(radius, z), ...], segments, loc, rot, mat)` turned shape; `p.plane(name, (x, y), loc, rot, mat)`; `p.jitter(ob, amount, seed)`.',
  '- Materials: `p.material(name, \'#rrggbb\', rough=0.8, metal=0.0, emission=0.0)`, one per name, reused.',
  '- Modifiers, named so adding one again replaces it: `p.bevel(ob, width, segments=2, angle=30)`, `p.array(ob, count, (dx, dy, dz))`, `p.mirror(ob, axes=(True, False, False), about=other)`, `p.solidify(ob, thickness)`, `p.subsurf(ob, levels)`, `p.boolean_cut(ob, cutter)` (the cutter never ships).',
  '- Structure: `p.collection(\'Legs\')` (a group inside `Export`, passed as `col=`), `p.parent(child, parent)`, `p.part(name)`, `p.remove(*names)`, `p.ground()`, `p.center()`, `p.origin_to_base(ob)`, `p.apply_scale(ob)`, `p.stats()`.',
  '',
  '```python',
  '"""Blocking out the main mass: hull, cabin and four wheels"""',
  'import math',
  'paint = p.material(\'Paint\', \'#b03a2e\', rough=0.5)',
  'tyre = p.material(\'Tyre\', \'#222222\', rough=0.9)',
  'p.box(\'Hull\', (1.8, 4.2, 0.7), loc=(0, 0, 0.75), mat=paint, bevel=0.05)',
  'p.box(\'Cabin\', (1.6, 2.0, 0.6), loc=(0, 0.3, 1.4), mat=paint)',
  'for i, (x, y) in enumerate([(1.05, -1.3), (-1.05, -1.3), (1.05, 1.3), (-1.05, 1.3)]):',
  '    p.cylinder(f\'Wheel {i + 1}\', 0.4, 0.3, loc=(x, y, 0.4), rot=(0, math.pi / 2, 0), mat=tyre)',
  '```'
].join('\n')

/** The brief addition for a Modeller unit: how to work in small, reviewed Blender steps. */
export function modellerBrief(pluginDir: string, taskDataDir: string): string {
  const skill = fwd(blenderSkillDir(pluginDir))
  const kernel = fwd(modellerScript(pluginDir))
  const data = fwd(modellerDataDir(taskDataDir))
  return [
    `You are a Modeller: you build a 3D model in small steps that the player watches live. Every kind of model is in scope. The API card below is enough to start; \`${skill}/SKILL.md\`, section "Modeller steps", has the rest (checks, kernel operations, Blender 4.2 and 5.2 traps in raw bpy) for when you need it.`,
    '- You write Python (bpy) step scripts; Genio runs each in its own headless Blender. There is no MCP and no live Blender session.',
    `- Start each model once: \`node "${kernel}" init <model> --target <unity|godot|web>\` (add \`--budget <triangles>\` or \`--size <x>x<y>x<z>\` when the mission gives them). Run one step: \`node "${kernel}" step <model> <script.py>\`.`,
    '- One step per script: one idea (legs, bracing, deck, roof) with 3 to 15 named parts, in your worktree under `.genio/modeller/<model>/`, numbered `s01_legs.py`, `s02_bracing.py`. Write the script and run its `step` command in the same response (the file write, then the command), never in a separate turn.',
    '- The first step is one small script that blocks out the main mass with simple parts, so the player sees the model within about a minute. Do not plan or write later steps before it has run; detail comes one step at a time.',
    `- \`node "${kernel}" batch <model> <script.py>...\` only replays scripts that already exist (restoring work after a revert or on a new branch). Never build new steps with it.`,
    '- After every step, open the review sheet PNG it prints (3/4, front, side and top views) and read its warnings. Fix what is wrong before adding anything new: a fix is its own step, or `--amend` the last one.',
    '- Textures: for a low-poly web model, bake or paint at 1024 px (2048 px only when the mission asks for it).',
    '- The warnings and checks are information for you and the player, never a gate. You decide when the model is done; then deliver it as the Modeller delivery under Definition of done says, like any Build.',
    '- Steering ("steeper roof") becomes the next step. `revert <model> <step>` or `branch <model> <name> --from <step>` goes back to an earlier version; `status <model>` lists the steps.',
    `- Steps, .blend snapshots, GLBs and review sheets live in \`${data}/\` (GENIO_MODELLER_DATA). Never copy them into the worktree or commit them, except what the Modeller delivery under Definition of done names for the finished model.`,
    '- A failed, crashed or hung step leaves the model at its last good step. Read the error and trace it prints, fix the script and run it again; do not retry it unchanged.',
    '',
    MODELLER_API_CARD
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
