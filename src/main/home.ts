import os from 'node:os'
import path from 'node:path'
import { ensureDir, exists, writeText } from './util'
import { assertMounted, volumeHome, volumePlacement, type CloneOptions } from '../../resources/unit-skills/genio/skills/play/scripts/clone.mjs'

/**
 * Base layout (companion's AG_HOME). Everything that matters lives
 * on disk here so a restart is a non-event.
 *
 *   config/            local operating choices (settings.json; main home only)
 *   data/              durable private records
 *     projects.json    project registry
 *     backlog.json     Quest Log (work items, holds, deps)
 *     decisions.json   open + resolved player choices (Your Move)
 *     allies.json      registered allies (main base only)
 *     player.md        Player Profile: preferences (base-local)
 *     player-shared.md preferences inherited by allies (main only)
 *     lore.md          curated squad knowledge (Squad memory)
 *     chat.jsonl       Comms transcript
 *     inbox.jsonl      Mail from the player
 *     fleet-ledger.jsonl opt-in Replay log
 *     stats.json       xp, achievements
 *     <task>/          brief.md, report.md, inbox.jsonl, validation.log
 *   state/             runtime records
 *     tasks.json       task metadata
 *     <task>.status    append-only worker status lines
 *     wakes.jsonl      durable event queue; wakes.ack holds the ack cursor
 *     away.json        presence: online / dnd / afk
 *     wksp.json        agent session ids for resume
 *     session.lock     single-writer lock
 *   projects/          clones (read-only to Genio itself)
 *   worktrees/         one isolated worktree per task (see placeWorktree)
 *   claude-home/      Genio's own Claude Code config folder (main only; claude-home.ts)
 *   wksps/<name>/      isolated ally bases (same layout)
 */
export class Home {
  readonly name: string
  readonly root: string
  readonly parent?: Home
  private readonly taskStorage = new Map<string, string>()

  constructor(root: string, name = 'main', parent?: Home) {
    this.root = path.resolve(root)
    this.name = name
    this.parent = parent
  }

  get isMain(): boolean {
    return !this.parent
  }

  get config(): string { return path.join(this.root, 'config') }
  get data(): string { return path.join(this.root, 'data') }
  get state(): string { return path.join(this.root, 'state') }
  get projects(): string { return path.join(this.root, 'projects') }
  get worktrees(): string { return path.join(this.root, 'worktrees') }
  get wksps(): string { return path.join(this.root, 'wksps') }

  get settingsFile(): string { return path.join(this.config, 'settings.json') }
  get projectsFile(): string { return path.join(this.data, 'projects.json') }
  get backlogFile(): string { return path.join(this.data, 'backlog.json') }
  get decisionsFile(): string { return path.join(this.data, 'decisions.json') }
  get alliesFile(): string { return path.join(this.data, 'allies.json') }
  get playerFile(): string { return path.join(this.data, 'player.md') }
  get playerSharedFile(): string { return path.join((this.parent ?? this).data, 'player-shared.md') }
  get loreFile(): string { return path.join(this.data, 'lore.md') }
  get loreArchive(): string { return path.join(this.data, 'archive', 'lore-cold.md') }
  get chatFile(): string { return path.join(this.data, 'chat.jsonl') }
  get inboxFile(): string { return path.join(this.data, 'inbox.jsonl') }
  get ledgerFile(): string { return path.join(this.data, 'fleet-ledger.jsonl') }
  get statsFile(): string { return path.join(this.data, 'stats.json') }
  get tasksFile(): string { return path.join(this.state, 'tasks.json') }
  get wakesFile(): string { return path.join(this.state, 'wakes.jsonl') }
  get wakesAckFile(): string { return path.join(this.state, 'wakes.ack') }
  get awayFile(): string { return path.join(this.state, 'away.json') }
  get wkspFile(): string { return path.join(this.state, 'wksp.json') }
  get lockFile(): string { return path.join(this.state, 'session.lock') }

  setTaskStorage(id: string, root: string): void { this.taskStorage.set(id, path.resolve(root)) }
  taskStateFile(id: string, suffix: string): string {
    return path.join(this.taskStorage.get(id) ?? this.root, 'state', `${id}${suffix}`)
  }
  taskDir(id: string): string { return path.join(this.taskStorage.get(id) ?? this.root, 'data', id) }
  briefFile(id: string): string { return path.join(this.taskDir(id), 'brief.md') }
  reportFile(id: string): string { return path.join(this.taskDir(id), 'report.md') }
  taskInboxFile(id: string): string { return path.join(this.taskDir(id), 'inbox.md') }
  taskInboxLog(id: string): string { return path.join(this.taskDir(id), 'inbox.jsonl') }
  validationLog(id: string): string { return path.join(this.taskDir(id), 'validation.log') }
  statusFile(id: string): string { return this.taskStateFile(id, '.status') }
  worktreeFor(project: string, id: string): string { return path.join(this.worktrees, project, id) }
  wkspHome(name: string): string { return path.join(this.wksps, name) }

  /** Create the layout and seed the human-editable memory files. */
  ensure(): void {
    for (const d of [this.config, this.data, this.state, this.projects, this.worktrees]) ensureDir(d)
    if (!exists(this.playerFile)) {
      writeText(
        this.playerFile,
        `# Player Profile\n\nHow the player likes to work. Genio reads this at every session start.\nEdit freely; Genio keeps it curated on /save.\n\n## Play style\n\n## Projects & priorities\n\n## Don'ts\n`
      )
    }
    if (!exists(this.loreFile)) {
      writeText(
        this.loreFile,
        `# Squad memory\n\nCurated, base-local squad knowledge. Markers: <!--P--> pinned, <!--a:DATE--> aging (stale after 30d), <!--p:DATE--> perishable (stale after 7d).\n\n`
      )
    }
    if (this.isMain && !exists(this.playerSharedFile)) {
      writeText(this.playerSharedFile, `# Shared Player Profile\n\nInherited by every ally.\n\n`)
    }
  }
}

/**
 * Where a unit worktree goes: on the project's own volume when that volume block clones (a Dev Drive)
 * and this base lives elsewhere, as <volume>/.genio/<key>/worktrees/<world>/<id>; otherwise worktrees/.
 */
export async function placeWorktree(home: Home, project: { name: string; path: string }, id: string, options?: CloneOptions): Promise<string> {
  assertMounted(project.path, options)
  const volume = await volumePlacement(project.path, home.worktrees, options)
  return volume ? path.join(volumeHome(home.root, volume), 'worktrees', project.name, id) : home.worktreeFor(project.name, id)
}

export function defaultHomeRoot(): string {
  return process.env.GENIO_HOME ? path.resolve(process.env.GENIO_HOME) : path.join(os.homedir(), '.genio')
}
