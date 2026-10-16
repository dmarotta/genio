/**
 * Unit briefs (companion bin/fm-brief.sh + fm-dod-lib.sh). The brief is a
 * safety contract: isolation assertion, status protocol, ping inbox and a
 * per-mode definition of done.
 */
import fs from 'node:fs'
import type { DeliveryMode, Engine, TaskKind } from '@shared/types'
import { fwd, nowIso } from './util'
import type { SubmoduleReport } from '../../resources/unit-skills/genio/lib/git-submodules.mjs'

export interface BriefInput {
  taskId: string
  kind: TaskKind
  project: string
  worktree: string
  branch: string
  baseBranch: string
  mode?: DeliveryMode
  yolo?: boolean
  intent: string
  spec?: string
  /** A plan step's handoff note: the plan, this step's acceptance, and what landed before it */
  planContext?: string
  statusFile: string
  inboxDir: string
  taskDataDir: string
  reportPath?: string
  engine?: Engine
  engineHints?: string
  /** Opens the Engine notes: the project's engine, version and root (see engineBriefLine). */
  engineLine?: string
  briefInclude?: string
  /** Recon report carried into an upgraded Build brief */
  carriedReport?: string
  /** Bundled unit skills (paths only, never keys) */
  tools?: string
  /** A Modeller unit's working rules (modellerBrief), rendered after Tools */
  modeller?: string
  /** A Modeller's delivery lines (modellerDoneLines), opening its Definition of done */
  modellerDone?: string[]
  /** The project's Art Bible lines under Tools (artBibleBriefLines); absent without a bible */
  artBible?: string[]
  /** Recon: the report summary's word target from the Usage mode */
  summaryWords?: number
  /** Submodules Genio checked out in the worktree (initWorktreeSubmodules) */
  submodules?: SubmoduleReport
  /** A worktree with a package.json: Genio's private node_modules setup record and the setup script */
  nodeDeps?: { stateFile: string; setup: string }
}

/** Setup lines on the worktree's own node_modules (docs/unit-worktrees.md). */
export function nodeDepsLines(d?: BriefInput['nodeDeps']): string[] {
  if (!d) return []
  return [
    `- Dependencies: Genio is installing this worktree's own private \`node_modules\` in the background (a copy of the main checkout's when the lockfiles match, otherwise \`npm ci --prefer-offline\` here). \`${fwd(d.stateFile)}\` says \`installing\`, \`ready\`, \`failed\` or \`skipped\`; wait for \`ready\` before running node tools.`,
    '- That `node_modules` is yours alone: you may run `npm install` or `npm ci` inside this worktree. Never link, junction or move `node_modules`, never point it at another folder, and never touch the main checkout\'s `node_modules`: an install through a link deletes and rewrites the folder it points to.',
    `- If it is missing or broken, run \`node "${fwd(d.setup)}" setup\` in the worktree (it removes a link only, then copies or installs).`
  ]
}

/** Setup lines on the worktree's submodules: none without any, a visible warning when some are missing. */
export function submoduleLines(r?: SubmoduleReport): string[] {
  if (!r?.submodules.length && !r?.problems.length) return []
  const ready = r.submodules.filter((s) => s.action !== 'failed' && s.action !== 'skipped').map((s) => `\`${s.path}\``)
  const out: string[] = []
  if (ready.length) out.push(`- Genio checked out the git submodules ${ready.join(', ')} at this branch's commits, from the main checkout's local copies. Never run \`git submodule init\`, \`update\` or \`sync\` yourself: they write the main checkout's shared config and may reach the network.`)
  if (r.problems.length) out.push(`- WARNING: Genio could not initialise these git submodules, so their files are missing from your worktree: ${r.problems.join('; ')}. If your mission needs them (a Unity package there will not resolve), append \`blocked: git submodules missing\` and stop.`)
  return out
}

export const MODE_LABEL: Record<DeliveryMode, string> = {
  'no-mistakes': 'Hardcore',
  'direct-PR': 'Standard',
  'local-only': 'Offline'
}

/** `modeller`: a Modeller never writes .meta files, so Unity's pairing rule becomes that. */
export function engineHints(engine?: Engine, modeller = false): string {
  const common =
    '- Binary assets (textures, audio, models, scenes) may be tracked with Git LFS: never rewrite or re-encode assets you were not asked to touch.\n' +
    '- Scene/prefab/level files merge badly: keep edits to them minimal and focused.'
  switch (engine) {
    case 'godot':
      return `- Engine: Godot. Run headless with \`godot --headless --path . --quit\` to check the project loads; if GUT is installed run \`godot --headless -s addons/gut/gut_cmdln.gd\`.\n- Edit .tscn/.tres as text carefully; keep UIDs and resource ids stable.\n${common}`
    case 'unity':
      return `- Engine: Unity. genio-unity (the unity skill under Tools, also in GENIO_UNITY) is the only way to compile, test, import, build, play, send editor commands and read the console. It targets only your own copy (GENIO_UNITY_PROJECT) or your leased Play slot and keeps a record of every run in GENIO_UNITY_RUNS.\n- Never start Unity.exe, Unity Hub or the \`unity\` CLI yourself. Never open, read or write the main project folder, never read an editor's Pipeline token and never save the player's scenes.\n- Never commit Library/, Temp/ or Logs/. ${modeller ? 'Never create .meta files: Unity writes them when the player imports your model.' : 'Keep .meta files paired with their assets.'}\n${common}`
    case 'unreal':
      return `- Engine: Unreal. Build with UnrealBuildTool / RunUAT when available; never commit Binaries/, Intermediate/, Saved/ or DerivedDataCache/.\n- .uasset/.umap are binary: do not modify them unless asked.\n${common}`
    case 'bevy':
      return `- Engine: Bevy (Rust). Use \`cargo build\`, \`cargo test\`, \`cargo clippy\`. Keep systems small and ECS-friendly.\n${common}`
    case 'love2d':
      return `- Engine: LÖVE (Lua). Run with \`love .\`.\n${common}`
    case 'gamemaker':
      return `- Engine: GameMaker. .yy/.yyp files are JSON-like: preserve ordering and resource ids.\n${common}`
    case 'defold':
      return `- Engine: Defold. Keep game.project and collection/go files consistent; bob.jar builds headless.\n${common}`
    case 'monogame':
      return `- Engine: MonoGame (.NET). Use \`dotnet build\`, \`dotnet test\`. Content pipeline (.mgcb) entries must match files.\n${common}`
    case 'web':
      return `- Engine: web (JS/TS). Use the package scripts (build/test/lint). Do not add heavy dependencies without need.\n${common}`
    default:
      return common
  }
}

/** A status append command that works in bash and PowerShell alike. */
export function appendCommand(statusFile: string, example = 'working: <one short line>'): string {
  const f = fwd(statusFile)
  return `echo "${example}" >> "${f}"`
}

/** The same append for Windows PowerShell 5.1, whose `>>` writes UTF-16 and `Add-Content` ANSI unless told UTF-8. */
export function appendCommandPowerShell(statusFile: string, example = 'working: <one short line>'): string {
  return `Add-Content -Encoding utf8 -LiteralPath "${fwd(statusFile)}" -Value '${example.replace(/'/g, "''")}'`
}

/**
 * A Modeller's delivery: where the export goes, its format per engine, no .meta, what is committed
 * (the export, a compressed .blend under ArtSource, the build scripts), claims, LFS, and Accept.
 * `locate` is the unit's asset_locate command (the FAL helper's `locate`).
 */
export function modellerDoneLines(o: { engine?: Engine; engineRoot?: string; locate: string; claims?: string[] }): string[] {
  const unity = o.engine === 'unity'
  const root = o.engineRoot && o.engineRoot !== '.' ? o.engineRoot : ''
  const fmt = unity ? 'fbx' : 'glb'
  const target = unity ? 'unity' : o.engine === 'godot' ? 'godot' : 'web'
  const artSource = [root, 'ArtSource', '3D'].filter(Boolean).join('/')
  const out = [
    'Modeller delivery (this comes first; the numbered steps below follow it):',
    `- Target path: the mission's, or one from asset_locate: \`node "${fwd(o.locate)}" locate --world . --kind model --name <model>.${fmt} --engine ${o.engine ?? 'other'}${root ? ` --engine-root ${root}` : ''}\`. Revising an existing model overwrites its export in place.`,
    o.claims?.length
      ? `- Claims: Genio gave you ${o.claims.map((c) => `\`${c}\``).join(', ')}. Before you write any other export or .blend, claim it: \`note [key=claim]: <path>\`. A path another Modeller holds is a \`blocked\` line, never an overwrite.`
      : '- Claims: before you write an export or a .blend, claim its path: `note [key=claim]: <path>`. A path another Modeller holds is a `blocked` line, never an overwrite.',
    `- Export the accepted step only (\`modeller.mjs materialize <model> <step>\`, then genio_bpy \`export <that .blend> <target> --target ${target} --fmt ${fmt}\`). ${unity ? 'Unity gets FBX' : 'Godot and web get GLB'}. 1 Blender unit = 1 m; the model is authored Z up, origin at ground centre, front -Y, and exported Y up.`,
    ...(unity ? ['- Unity axis: import the FBX on your own copy with genio-unity and check its root rotation. A static FBX usually arrives with a -90° X root rotation unless "Bake Axis Conversion" is ticked in its import settings, which live in the .meta you never write. Say in your done line whether it arrived upright.'] : []),
    '- Never create a `.meta` file. Revising a model leaves its existing `.meta` untouched, so GUID references and import settings survive.',
    `- Commit exactly: the export; a compressed \`.blend\` of the same step under \`${artSource}/\`${unity ? ' (never under `Assets/`: Unity would import it through a local Blender)' : ''}; and the step scripts in \`.genio/modeller/<model>/\` with a copy of the model's manifest.json. Never commit step data (snapshots, step GLBs, review sheets).`,
    '- Git LFS: if `.gitattributes` uses `filter=lfs`, run `git check-attr filter -- <file>` for each binary. A binary over 1 MB, or one whose type the LFS rules do not cover, is a `needs-decision` before you commit it. Never edit `.gitattributes`.',
    '- Before `done`, ask: `needs-decision [key=accept]: Accept step <n> of <model>?` with options `["Accept step <n>","Keep steering"]`. Then stop. The player answers with Accept on your page or by steering; deliver only the step they accept.',
    ''
  ]
  return out
}

function dod(i: BriefInput): string {
  const lines: string[] = []
  if (i.kind === 'scout') {
    const r = fwd(i.reportPath ?? `${i.taskDataDir}/report.md`)
    lines.push('Delivery contract: kind=recon')
    lines.push(`Report: ${r}`)
    lines.push('')
    lines.push(`1. Write the report at \`${r}\`: what you did, findings, evidence with \`file:line\` references, and recommendations.`)
    lines.push(`   Keep report.md to a summary of at most ${i.summaryWords ?? 800} words and 6000 characters by default, including findings, recommendation and links. Put supporting detail in separate evidence appendices it links to. Detail the mission explicitly asks for overrides this target.`)
    lines.push('2. If the findings raise choices only the player can make, append a `needs-decision [key=<slug>]: <question>` line for each BEFORE you finish, and stop until they are resolved.')
    lines.push('3. Never push, open a PR, or commit to shared branches. This worktree is scratch.')
    lines.push('4. Finish with `done: <one-line conclusion>` and stop.')
    return lines.join('\n')
  }
  const mode = i.mode ?? 'no-mistakes'
  lines.push(`Delivery contract: mode=${mode} (${MODE_LABEL[mode]})`)
  lines.push(`Build branch: ${i.branch}`)
  lines.push(`Base branch: ${i.baseBranch}`)
  lines.push('')
  if (i.modellerDone?.length) lines.push(...i.modellerDone)
  if (mode === 'no-mistakes' && i.modellerDone?.length) {
    lines.push('1. Commit the accepted model on the build branch with a clear commit message.')
    lines.push("2. Append `done: <summary>` and stop. Genio pushes the branch and opens the PR without running checks: the player's review of the live view is the gate.")
    lines.push('3. Do not push and do not open a PR yourself.')
  } else if (mode === 'no-mistakes') {
    lines.push('1. Implement the mission. Commit all work on the build branch with clear commit messages.')
    lines.push('2. Append `done: <summary>` and stop. Genio then runs the Gauntlet (checks, review, push, PR, CI).')
    lines.push('3. If Genio pings you with Gauntlet findings, fix them, commit, and append `done: <summary of fixes>` again.')
    lines.push('4. Do not push and do not open a PR yourself; the Gauntlet does it.')
  } else if (mode === 'direct-PR') {
    lines.push('1. Implement the mission and commit on the build branch.')
    lines.push(`2. Push the branch and open a NON-draft pull request against \`${i.baseBranch}\` (use \`gh pr create\`).`)
    lines.push('3. Append `done: PR <full https url>` and stop. A PR deliberately kept as a draft is reported with `paused: <why>` instead.')
  } else {
    lines.push('1. Implement the mission and commit on the build branch. Do not push, open a PR, or merge.')
    lines.push(`2. Keep the branch a clean fast-forward of the local \`${i.baseBranch}\` (rebase onto it if it moved; not origin's copy, which may be behind).`)
    lines.push(`3. Append \`done: ready in branch ${i.branch}\` and stop. Genio lands it after approval.`)
  }
  return lines.join('\n')
}

export function renderBrief(i: BriefInput): string {
  const wt = fwd(i.worktree)
  const status = fwd(i.statusFile)
  const inbox = fwd(i.inboxDir)
  const data = fwd(i.taskDataDir)
  const isShip = i.kind === 'ship'
  const mode = i.mode ?? 'no-mistakes'
  const pushRule = !isShip
    ? 'Never push, never open a PR, never commit to shared branches: this is a Recon mission.'
    : mode === 'local-only'
      ? 'Never push. Never merge. Never touch the default branch.'
      : mode === 'direct-PR'
        ? `Push only the build branch \`${i.branch}\`. Never push to the default branch. Never merge a PR.`
        : 'Never push to the default branch. Never merge a PR. Leave pushing to the Gauntlet.'

  const out: string[] = []
  out.push(`# Genio unit brief — ${i.taskId}`)
  out.push('')
  out.push("You are a unit in Genio's squad: an autonomous coding agent. Work on your own; never wait for a human, never address the player. All communication goes through your status file and Genio's ping inbox.")
  out.push('')
  out.push('# Mission')
  out.push('')
  out.push(`Project: ${i.project} · Type: ${isShip ? 'BUILD' : 'RECON'}${isShip ? ` · Mode: ${MODE_LABEL[mode]}` : ''}`)
  out.push('')
  out.push("## Player's intent")
  out.push('')
  out.push(i.intent.trim() || '(no intent given)')
  out.push('')
  out.push('## Genio spec')
  out.push('')
  out.push(i.spec?.trim() || 'No extra build instructions. Deliver exactly the intent above; anything beyond it is out of scope.')
  if (i.planContext?.trim()) {
    out.push('')
    out.push('## Plan context')
    out.push('')
    out.push(i.planContext.trim())
  }
  if (i.carriedReport) {
    out.push('')
    out.push('## Recon report carried into this build')
    out.push('')
    out.push(i.carriedReport.trim())
  }
  out.push('')
  out.push('# Setup')
  out.push('')
  out.push(`- You are in a disposable git worktree of **${i.project}** at \`${wt}\`.`)
  out.push(`- Genio already created and checked out the branch \`${i.branch}\` from \`${i.baseBranch}\`.`)
  out.push('- ISOLATION ASSERTION (do this first): run `git rev-parse --show-toplevel`. It must resolve to the worktree path above.')
  out.push(`  If it does not, run \`${appendCommand(i.statusFile, 'blocked: launched outside the isolated worktree')}\` and stop immediately.`)
  out.push(...submoduleLines(i.submodules))
  out.push(...nodeDepsLines(i.nodeDeps))
  out.push('')
  out.push('# Rules')
  out.push('')
  out.push(`1. ${pushRule}`)
  out.push(`2. Edit only inside the worktree. Put scratch output under \`${data}/\`. Leave the worktree clean when you finish.`)
  out.push(`3. Report status by appending ONE line to \`${status}\`:`)
  out.push('   ```')
  out.push(`   ${appendCommand(i.statusFile)}`)
  out.push('   ```')
  out.push(`   (works in bash and PowerShell). For text beyond plain ASCII in Windows PowerShell, write UTF-8 explicitly: \`${appendCommandPowerShell(i.statusFile)}\`. Format: \`<verb> [key=<slug>]: <one short line>\`.`)
  out.push('   Verbs: `working` (material phase change only), `needs-decision` (a product choice only the player can make; then stop), `blocked` (you are stuck and need Genio), `paused` (a declared wait, optionally `until <YYYY-MM-DDTHH:MMZ>`), `done`, `failed`, `note`, `resolved [key=<slug>]` (a blocker cleared on its own).')
  out.push('   Report sparingly: status lines are events, not progress logs. Always write full `https://` PR URLs.')
  out.push('4. Hitting the same obstacle twice means `blocked: <what you need>`.')
  out.push('5. After `needs-decision` or `blocked`, stop and wait for a ping; do not guess the answer.')
  out.push('6. Never administer shared infrastructure: no `git worktree add/remove`, no deleting branches you did not create, no global config changes. Append `blocked: <what you need>` instead.')
  out.push('7. Never merge PRs and never push to the default branch.')
  out.push('')
  out.push('# Authoring choices')
  out.push('')
  out.push('Write a short, human-readable question about the decision and its consequence. Put technical diagnostics (PIDs, paths, commands, logs) in Details, never in the question. Supply exact answer strings as options and an explicit recommendation; do not bury alternatives or approval in diagnostic prose.')
  out.push('Append optional JSON metadata after ` || ` on the same status line (legacy plain lines still work):')
  out.push('```text')
  out.push('needs-decision [key=scene]: May I close my test scene so I can run the checks? || {"options":["Close the test scene and run checks","Keep it open"],"recommendation":"Close the test scene and run checks","details":"Only the isolated test copy is affected. PID, project path and exact command go here.","batch":"scene-checks"}')
  out.push('```')
  out.push('Use JSON.stringify or your language\'s JSON encoder, then append the complete line; avoid shell quoting that executes commands from diagnostics. `batch` is optional: use the same slug only for related choices within this project; otherwise choices group by originating task. Recommendations must be exact answers, not explanations. Put the rationale in `details`.')
  out.push('A clarification ping is a question, not approval. Keep the choice unresolved and reply by updating the same key with a clearer question/options/Details; never append resolved or start the proposed action on clarification alone.')
  out.push('')
  out.push('# Genio ping inbox')
  out.push('')
  out.push(`Genio sends instructions as files in \`${inbox}/\`. When your terminal shows a "Genio ping waiting" line (or whenever you are idle):`)
  out.push(`list \`${inbox}/*.msg\`, read and act on each in numeric order, then move each into \`${inbox}/handled/\`. The move is your acknowledgement.`)
  out.push('')
  out.push('# Project memory')
  out.push('')
  out.push("Edit the project's AGENTS.md or CLAUDE.md only to correct information that is factually wrong (including what your own change made wrong). Never add new knowledge to them.")
  out.push('')
  out.push('# Engine notes')
  out.push('')
  if (i.engineLine?.trim()) out.push(i.engineLine.trim())
  out.push((i.engineHints ?? engineHints(i.engine)).trim())
  out.push('')
  if (i.tools?.trim() || i.artBible?.length) {
    out.push('# Tools')
    out.push('')
    if (i.tools?.trim()) out.push(i.tools.trim())
    out.push(...(i.artBible ?? []))
    out.push('')
  }
  if (i.modeller?.trim()) {
    out.push('# Modeller')
    out.push('')
    out.push(i.modeller.trim())
    out.push('')
  }
  out.push('# Definition of done')
  out.push('')
  out.push(dod(i))
  if (i.briefInclude?.trim()) {
    out.push('')
    out.push('# Base brief additions')
    out.push('')
    out.push(i.briefInclude.replace(/^Delivery contract:.*$/gim, '').trim())
  }
  out.push('')
  return out.join('\n')
}

/** Append a respawn progress note to an existing brief. */
export function appendProgressNote(briefPath: string, note: string): void {
  const body = note.trim() || 'Respawned by Genio. Re-read this brief, check `git status` and `git log`, and continue where you left off.'
  fs.appendFileSync(briefPath, `\n## Progress note (${nowIso()})\n\n${body}\n`, 'utf8')
}

/** One-line kickoff prompt passed to the unit CLI. */
export function kickoffPrompt(briefPath: string): string {
  return `You are a Genio unit. Read your brief at ${fwd(briefPath)} and follow it exactly. Start now.`
}

export function doorbellLine(inboxDir: string): string {
  const d = fwd(inboxDir)
  return `Genio ping waiting: list ${d}/*.msg, read and act on each in numeric order, then move each into ${d}/handled/.`
}
