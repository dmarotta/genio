/**
 * Skills Genio bundles for its units (assets, Codex images on the ChatGPT
 * plan, FAL.ai, Uthana, the Sound Studio, Blender, Unity). The source lives in
 * resources/unit-skills/genio, laid out as a Claude Code plugin. At launch it
 * is installed into the main base's skills/ folder, never into a world: Claude
 * Code units load it with --plugin-dir, every runtime gets the SKILL.md paths
 * in its brief and as GENIO_FAL_SKILL, GENIO_SOUND_SKILL and the like
 * (UNIT_CAPABILITIES), and the genio-unity wrapper as GENIO_UNITY. Every unit
 * gets every skill, whatever its kind or runtime; only the mission rules
 * differ. The FAL key reaches a unit only as the FAL_KEY environment variable
 * of its process, the Uthana key only as UTHANA_API_KEY; a key never lets a
 * unit spend without a spend grant.
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
/** A unit's Sound Studio sets: its data folder, never its worktree (sound.mjs's own fallback). */
export const soundDataDir = (taskDataDir: string): string => path.join(taskDataDir, 'sound')

/** One bundled skill: its folder under skills/, its path variable and what it needs to run. */
export interface UnitCapability {
  skill: string
  env: string
  /** What it is for, in the brief's capability list */
  use: string
  /** Its own prerequisite, stated plainly */
  needs: string
}

/**
 * The capability set: every unit gets all of it (paths in its brief and environment), whatever its
 * kind (Recon, Build, Modeller, Generator) or runtime (Claude, Codex, others). A key being set never
 * means a unit may spend: paid helpers refuse without a spend grant.
 */
export const UNIT_CAPABILITIES: readonly UnitCapability[] = [
  { skill: 'assets', env: 'GENIO_ASSETS_SKILL', use: 'provider routing, placement and how to ask for spend', needs: 'nothing' },
  { skill: 'imagegen-codex', env: 'GENIO_IMAGEGEN_CODEX_SKILL', use: 'images', needs: "the player's ChatGPT plan; free, no approval" },
  { skill: 'fal', env: 'GENIO_FAL_SKILL', use: 'textures, 3D, audio, music, video', needs: 'the FAL key and a spend grant' },
  { skill: 'uthana', env: 'GENIO_UTHANA_SKILL', use: 'character motions', needs: 'the Uthana key and a spend grant' },
  { skill: 'sound', env: 'GENIO_SOUND_SKILL', use: 'SFX sets, UI sounds, ambience loops', needs: 'nothing for local steps; its FAL steps need the FAL key and a spend grant' },
  { skill: 'blender', env: 'GENIO_BLENDER_SKILL', use: 'batch modelling, export, Modeller steps', needs: 'a local Blender' },
  { skill: 'unity', env: 'GENIO_UNITY_SKILL', use: 'compile, test, import, build, play', needs: 'a Unity project' }
]
export const unitSkillDir = (pluginDir: string, skill: string): string => path.join(pluginDir, 'skills', skill)

/** Skills whose SKILL.md a brief does not name: empty when the unit has the whole capability set. */
export function capabilityGaps(brief: string, pluginDir: string): string[] {
  return UNIT_CAPABILITIES.filter((c) => !brief.includes(`${fwd(unitSkillDir(pluginDir, c.skill))}/SKILL.md`)).map((c) => c.skill)
}

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

/** Characters Genio and its units uploaded to Uthana: Genio's data, never a world. */
export const uthanaDataDir = (dataDir: string): string => path.join(dataDir, 'uthana')

/**
 * Launch additions for a unit: the plugin dir for Claude Code (its native skill loader), and for every
 * runtime alike every skill path, the helpers' data folders, Codex image scratch, Genio's help docs and the
 * FAL and Uthana keys. Nothing here depends on the unit's kind.
 */
export function unitLaunchExtras(harnessId: string, opts: { pluginDir?: string; falKey?: string; uthanaKey?: string; dataDir?: string; taskDataDir?: string; project?: string; helpDocs?: string }): UnitLaunchExtras {
  const args: string[] = []
  const env: Record<string, string> = {}
  if (opts.helpDocs) env.GENIO_HELP_DOCS = fwd(opts.helpDocs)
  if (opts.pluginDir) {
    // First in argv: the next element is always another flag, never the prompt.
    if (harnessId === 'claude') args.push('--plugin-dir', opts.pluginDir)
    for (const c of UNIT_CAPABILITIES) env[c.env] = fwd(unitSkillDir(opts.pluginDir, c.skill))
    if (opts.taskDataDir ?? opts.dataDir) env.GENIO_BLENDER_SCRATCH = fwd(path.join((opts.taskDataDir ?? opts.dataDir)!, 'blender'))
    if (opts.taskDataDir) env.GENIO_MODELLER_DATA = fwd(modellerDataDir(opts.taskDataDir))
    if (opts.taskDataDir) env.GENIO_SOUND_DATA = fwd(soundDataDir(opts.taskDataDir))
    env.GENIO_UNITY = fwd(genioUnityScript(opts.pluginDir))
    if (opts.dataDir) env.GENIO_CODEX_IMAGE_SCRATCH = fwd(codexImageScratch(opts.dataDir))
    if (opts.dataDir) env.GENIO_UTHANA_DATA = fwd(uthanaDataDir(opts.dataDir))
    if (opts.project) env.GENIO_PROJECT = opts.project
  }
  const key = opts.falKey?.trim()
  if (key) env.FAL_KEY = key
  const uthana = opts.uthanaKey?.trim()
  if (uthana) env.UTHANA_API_KEY = uthana
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
  '- A step script runs in headless Blender on the previous step\'s scene with `bpy` and `p` preloaded. Line 1 is a one-line docstring caption in plain words; the player reads it live.',
  '- After each step read its `review` first: what changed, then floating parts, deep overlaps, z-fighting and symmetry by part name. Open the `sheet` only for shape, proportions and style.',
  '- Write each helper of yours once, in `lib.py` beside the step scripts: it runs before every step, so its functions are globals there.',
  '- Metres, Z up, the model stands on z = 0 with its footprint centred on the origin and its front facing -Y (its left side is +X).',
  '- A part made again under the same name replaces the old one, so a script can run twice. Part helpers return the object and take `mat=` and `col=`; `rot` is Euler radians.',
  '- Parts: `p.box(name, (sx, sy, sz), loc, rot, mat, bevel=0.0)` centred on loc; `p.cylinder(name, radius, depth, loc, rot, mat, radius_top=None)` along local Z; `p.sphere(name, radius, loc, mat, subdiv=2)`; `p.beam(name, a, b, thickness, mat)`; `p.prism(name, [(x, y), ...], depth, loc, rot, mat)` outline extruded along local Z; `p.lathe(name, [(radius, z), ...], segments, loc, rot, mat)`; `p.loft(name, [[(x, y, z), ...], ...], closed=True)` through sections of equal count (one point: a tip); `p.jitter(ob, amount, seed)`.',
  '- Materials: `p.material(name, \'#rrggbb\', rough=0.8, metal=0.0, emission=0.0)`, one per name, reused.',
  '- Modifiers, named so adding one again replaces it: `p.bevel(ob, width)`, `p.array(ob, count, (dx, dy, dz))`, `p.mirror(ob)`, `p.solidify(ob, thickness)`, `p.subsurf(ob, levels)`, `p.boolean_cut(ob, cutter)` (the cutter never ships).',
  '- Placing: `p.join(name, parts)`; `p.drop(ob, on=None)` onto the ground or the part `on`; `p.mirror_pair(ob)` (`Arm L` makes `Arm R`); `p.ring(ob, count, center, axis=\'Z\')` copies round an axis, from the first in place.',
  '- Structure: `p.collection(\'Legs\')` (a group inside `Export`, passed as `col=`), `p.parent(child, parent)`, `p.part(name)`, `p.remove(*names)`, `p.ground()`, `p.center()`, `p.origin_to_base(ob)`, `p.apply_scale(ob)`.',
  '- Paint: `p.uv_atlas()` once, `p.camo(mat, \'red\'|\'woodland\'|\'desert\'|\'digital\')`, `p.weathering(mat, wear=0.8, dirt=1.0)`, then `p.bake_maps(size=1024)`.',
  '',
  '```python',
  '"""Blocking out the main mass: the hull and four wheels"""',
  'import math',
  'paint = p.material(\'Paint\', \'#b03a2e\', rough=0.5)',
  'p.box(\'Hull\', (1.8, 4.2, 0.7), loc=(0, 0, 0.75), mat=paint, bevel=0.05)',
  'tyre = p.material(\'Tyre\', \'#222222\', rough=0.9)',
  'for i, y in enumerate((-1.3, 1.3)):',
  '    p.mirror_pair(p.cylinder(f\'Wheel {i + 1} L\', 0.4, 0.3, loc=(1.05, y, 0.4), rot=(0, math.pi / 2, 0), mat=tyre))',
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
    `- Start each model once: \`node "${kernel}" init <model> --target <unity|godot|web>\` (add \`--budget <triangles>\` or \`--size <x>x<y>x<z>\` when the mission gives them, and \`--symmetry x\` for a model mirrored left to right). Run one step: \`node "${kernel}" step <model> <script.py>\`.`,
    '- One step per script: one idea (legs, bracing, deck, roof) with 3 to 15 named parts, in your worktree under `.genio/modeller/<model>/`, numbered `s01_legs.py`, `s02_bracing.py`. Write the script and run its `step` command in the same response (the file write, then the command), never in a separate turn.',
    '- The first step is one small script that blocks out the main mass with simple parts, so the player sees the model within about a minute. Do not plan or write later steps before it has run; detail comes one step at a time.',
    `- \`node "${kernel}" batch <model> <script.py>...\` only replays scripts that already exist (restoring work after a revert or on a new branch). Never build new steps with it.`,
    '- After every step, read its text `review` (a few lines: what changed, then any floating parts, deep overlaps, z-fighting and symmetry problems, by part name) and its warnings (only those new since the previous step; `known_warnings` counts the ones still standing). Open the review sheet PNG it prints (3/4, front, side and top views, with the changed and flagged parts labelled) only when you need to see shape, proportions or style, or to place a defect. Fix what is wrong before adding anything new: a fix is its own step, or `--amend` the last one.',
    '- Textures: paint with `p.camo`/`p.weathering` (or your own nodes into the Principled BSDF) and bake once with `p.bake_maps()`, never with your own bake loop. For a low-poly web model, bake at 1024 px (2048 px only when the mission asks for it).',
    '- The review, warnings and checks are information for you and the player, never a gate. You decide when the model is done; then deliver it as the Modeller delivery under Definition of done says, like any Build.',
    '- Steering ("steeper roof") becomes the next step. `revert <model> <step>` or `branch <model> <name> --from <step>` goes back to an earlier version; `status <model>` lists the steps.',
    `- Steps, .blend snapshots, GLBs and review sheets live in \`${data}/\` (GENIO_MODELLER_DATA). Never copy them into the worktree or commit them, except what the Modeller delivery under Definition of done names for the finished model.`,
    '- A failed, crashed or hung step leaves the model at its last good step. Read the error and trace it prints, fix the script and run it again; do not retry it unchanged.',
    '',
    MODELLER_API_CARD
  ].join('\n')
}

/**
 * How a unit spends money: only under the player's approval (a spend grant), and how to ask for one.
 * `approvedUsd` is what the player approved for the unit so far (at deploy, or before a Recon's upgrade), if anything.
 */
export function spendRulesBrief(approvedUsd?: number): string {
  const start = approvedUsd && approvedUsd > 0
    ? `The player has approved USD ${approvedUsd.toFixed(2)} for you so far: that is your spend grant.`
    : 'You start with no spend grant (USD 0).'
  return (
    `- Spending: no paid call (FAL, Uthana, the Sound Studio's FAL steps, any paid provider) runs without the player's approval. ${start} ` +
    'The paid helpers check your grant and refuse with exit 6, sending nothing, when there is none or the call would pass it. ' +
    'To ask: append `needs-decision [key=spend]: <what you want to generate and why>` with JSON metadata `{"spend_usd": <amount>, "details": "<plan, estimate per call, total>"}`, then stop and wait for the ping. ' +
    'The player\'s approval records exactly that amount (grants add up); a decline records nothing, so work without that spend. Never write or edit your grant file (GENIO_SPEND_GRANT): only Genio signs grants. The project\'s monthly cap stops everything. ' +
    'Codex images on the ChatGPT plan are not a spend: use them freely, no approval needed.'
  )
}

/** The brief's short capability list: the same for every unit kind and runtime, each skill with its own prerequisite. */
export function capabilitiesBrief(): string {
  return (
    '- Capabilities: you have every skill below, as every unit does whatever its kind (Recon, Build, Modeller, Generator) or runtime; only the mission rules differ. ' +
    `Each needs only its own prerequisite: ${UNIT_CAPABILITIES.map((c) => `${c.skill} (${c.use}; needs ${c.needs})`).join(', ')}. The Art Bible applies when the project has one.\n` +
    '- Work is best done in units, and any paid call needs an approval (how to ask is in the assets skill, and under Spending below).'
  )
}

/**
 * The brief's pointer to the bundled skills and Genio's help docs, and how the unit may spend.
 * Paths only; never a key. The same for every unit kind. `approvedUsd` is what the player approved so far, if anything.
 */
export function unitToolsBrief(pluginDir: string, helpDocs?: string, approvedUsd?: number): string {
  const help = helpDocs ? `- Genio help (what a Genio feature, mode or setting does): read \`${fwd(helpDocs)}/help/glossary.md\`, then the docs listed in \`${fwd(helpDocs)}/help/help-set.json\` (folder also in GENIO_HELP_DOCS).\n` : ''
  const assets = fwd(assetsSkillDir(pluginDir))
  const uthana = fwd(uthanaSkillDir(pluginDir))
  const dir = fwd(falSkillDir(pluginDir))
  const codex = fwd(codexImageSkillDir(pluginDir))
  const blender = fwd(blenderSkillDir(pluginDir))
  const unity = fwd(unitySkillDir(pluginDir))
  const sound = fwd(soundSkillDir(pluginDir))
  return (
    `${capabilitiesBrief()}\n` +
    help +
    `- Unity (Unity projects only): read \`${unity}/SKILL.md\`. Compile, test, import, build, play, send editor commands and read the console only with \`node "${unity}/scripts/genio-unity.mjs" <verb>\` (also in GENIO_UNITY). It targets only your own copy or your leased Play slot. Never start Unity.exe, Unity Hub or the \`unity\` CLI yourself, never control the main editor and never touch the player's own editors and tools.\n` +
    `- Assets: read \`${assets}/SKILL.md\` first for provider routing and project-type placement. Use asset_locate / the shared suggestLocation helper.\n` +
    `${spendRulesBrief(approvedUsd)}\n` +
    `- Uthana (character motions, rigged characters): read \`${uthana}/SKILL.md\` and use \`node "${uthana}/scripts/uthana.mjs"\` with --world <your worktree root>, like the FAL helper. Its motions and auto-rigged uploads are paid calls under your spend grant. The key, when the player set one, is only in your UTHANA_API_KEY environment variable: never print or write it.\n` +
    `- Sound Studio (sets of game SFX, UI sounds, ambience loops): read \`${sound}/SKILL.md\` and use \`node "${sound}/scripts/sound.mjs"\`. Local steps (trim, fade, normalize, loop, pitch, layer) are free; its FAL steps are paid calls under your spend grant. Step data goes to GENIO_SOUND_DATA, outside your worktree, and is never committed.\n` +
    `- Blender (batch modelling, validation, export and conversion, and the Modeller steps in its SKILL.md): read \`${blender}/SKILL.md\` and use \`node "${blender}/scripts/blender.mjs"\`. Requires local Blender; no MCP or live session. Logs go to GENIO_BLENDER_SCRATCH, Modeller steps to GENIO_MODELLER_DATA.\n` +
    `- Images (default): Codex images on the player's ChatGPT plan, on in every project unless it opted out, free of approval. For concept art, sprites, icons, transparent cutouts and edits from references read \`${codex}/SKILL.md\` and use \`node "${codex}/scripts/codex-image.mjs"\`.\n` +
    `- FAL.ai (specific needs: seamless/PBR textures, 3D, audio, music, video, pixel-art conversion, upscaling, background removal, exact size/seed/reproducibility): before any FAL work read \`${dir}/SKILL.md\` and use its helper \`node "${dir}/scripts/fal.mjs"\`. ` +
    'Every model run is a paid call under your spend grant (Spending above); report what you spent. ' +
    'The key, when the player set one, is only in your FAL_KEY environment variable: never print or write it. ' +
    "Generate with --world <your worktree root>: it follows the project's .genio/fal/ config and recipes and records provenance and spend lines in .genio/, which you commit with the assets; never edit .genio/fal/config.json or recipes.json."
  )
}
