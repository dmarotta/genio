/**
 * Unit briefs (companion bin/fm-brief.sh + fm-dod-lib.sh). The brief is a
 * safety contract: isolation assertion, status protocol, ping inbox and a
 * per-mode definition of done.
 */
import fs from 'node:fs'
import type { DeliveryMode, Engine, TaskKind } from '@shared/types'
import { fwd, nowIso } from './util'

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
  statusFile: string
  inboxDir: string
  taskDataDir: string
  reportPath?: string
  engine?: Engine
  engineHints?: string
  briefInclude?: string
  /** Recon report carried into an upgraded Build brief */
  carriedReport?: string
}

export const MODE_LABEL: Record<DeliveryMode, string> = {
  'no-mistakes': 'Hardcore',
  'direct-PR': 'Standard',
  'local-only': 'Offline'
}

export function engineHints(engine?: Engine): string {
  const common =
    '- Binary assets (textures, audio, models, scenes) may be tracked with Git LFS: never rewrite or re-encode assets you were not asked to touch.\n' +
    '- Scene/prefab/level files merge badly: keep edits to them minimal and focused.'
  switch (engine) {
    case 'godot':
      return `- Engine: Godot. Run headless with \`godot --headless --path . --quit\` to check the project loads; if GUT is installed run \`godot --headless -s addons/gut/gut_cmdln.gd\`.\n- Edit .tscn/.tres as text carefully; keep UIDs and resource ids stable.\n${common}`
    case 'unity':
      return `- Engine: Unity. Tests run via \`Unity -batchmode -projectPath . -runTests -testPlatform EditMode\` when a Unity editor is installed.\n- Never commit Library/, Temp/ or Logs/. Keep .meta files paired with their assets.\n${common}`
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

function dod(i: BriefInput): string {
  const lines: string[] = []
  if (i.kind === 'scout') {
    const r = fwd(i.reportPath ?? `${i.taskDataDir}/report.md`)
    lines.push('Delivery contract: kind=recon')
    lines.push(`Report: ${r}`)
    lines.push('')
    lines.push(`1. Write the report at \`${r}\`: what you did, findings, evidence with \`file:line\` references, and recommendations.`)
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
  if (mode === 'no-mistakes') {
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
    lines.push(`2. Keep the branch a clean fast-forward of \`${i.baseBranch}\` (rebase onto it if it moved).`)
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
  out.push(`World: ${i.project} · Type: ${isShip ? 'BUILD' : 'RECON'}${isShip ? ` · Mode: ${MODE_LABEL[mode]}` : ''}`)
  out.push('')
  out.push("## Player's intent")
  out.push('')
  out.push(i.intent.trim() || '(no intent given)')
  out.push('')
  out.push('## Genio spec')
  out.push('')
  out.push(i.spec?.trim() || 'No extra build instructions. Deliver exactly the intent above; anything beyond it is out of scope.')
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
  out.push('')
  out.push('# Rules')
  out.push('')
  out.push(`1. ${pushRule}`)
  out.push(`2. Edit only inside the worktree. Put scratch output under \`${data}/\`. Leave the worktree clean when you finish.`)
  out.push(`3. Report status by appending ONE line to \`${status}\`:`)
  out.push('   ```')
  out.push(`   ${appendCommand(i.statusFile)}`)
  out.push('   ```')
  out.push('   (works in bash and PowerShell). Format: `<verb> [key=<slug>]: <one short line>`.')
  out.push('   Verbs: `working` (material phase change only), `needs-decision` (a product choice only the player can make; then stop), `blocked` (you are stuck and need Genio), `paused` (a declared wait, optionally `until <YYYY-MM-DDTHH:MMZ>`), `done`, `failed`, `note`, `resolved [key=<slug>]` (a blocker cleared on its own).')
  out.push('   Report sparingly: status lines are events, not progress logs. Always write full `https://` PR URLs.')
  out.push('4. Hitting the same obstacle twice means `blocked: <what you need>`.')
  out.push('5. After `needs-decision` or `blocked`, stop and wait for a ping; do not guess the answer.')
  out.push('6. Never administer shared infrastructure: no `git worktree add/remove`, no deleting branches you did not create, no global config changes. Append `blocked: <what you need>` instead.')
  out.push('7. Never merge PRs and never push to the default branch.')
  out.push('')
  out.push('# Genio ping inbox')
  out.push('')
  out.push(`Genio sends instructions as files in \`${inbox}/\`. When your terminal shows a "Genio ping waiting" line (or whenever you are idle):`)
  out.push(`list \`${inbox}/*.msg\`, read and act on each in numeric order, then move each into \`${inbox}/handled/\`. The move is your acknowledgement.`)
  out.push('')
  out.push('# World memory')
  out.push('')
  out.push("Edit the world's AGENTS.md or CLAUDE.md only to correct information that is factually wrong (including what your own change made wrong). Never add new knowledge to them.")
  out.push('')
  out.push('# Engine notes')
  out.push('')
  out.push((i.engineHints ?? engineHints(i.engine)).trim())
  out.push('')
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
