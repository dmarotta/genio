import fs from 'node:fs'
import path from 'node:path'
import type { Ally, BacklogItem, Decision, Project, Task, Wake } from '@shared/types'
import { Home } from './home'
import { allyNameForWorld, worldAllyRequest } from './project-chat'
import { allyCharterFile } from './prompts'
import { renderBacklogMirror } from './backlog'
import { nowIso, writeJsonAtomic, writeText } from './util'

interface Cursor { through: number; at?: string; events?: Record<string, string> }
interface Records {
  home: Home
  tasks: Task[]
  backlog: BacklogItem[]
  decisions: Decision[]
  wakes: Wake[]
  cursor: Cursor
}
interface Migration {
  version: 1
  startedAt: string
  completedAt?: string
  // Original UTF-8 contents are retained for recovery; null means the file was absent.
  writes: { file: string; before: string | null; after: string }[]
}

function contents(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function json<T>(file: string, fallback: T): T {
  const text = contents(file)
  return text === null ? fallback : JSON.parse(text) as T
}

function rows<T extends { id: string }>(file: string): T[] {
  const data = json<T[]>(file, [])
  if (!Array.isArray(data) || data.some(row => !row || typeof row.id !== 'string')) {
    throw new Error(`Invalid records in ${file}; project migration stopped without discarding them.`)
  }
  if (new Set(data.map(row => row.id)).size !== data.length) throw new Error(`Duplicate IDs in ${file}`)
  return data
}

function records(home: Home): Records {
  const wakes = (contents(home.wakesFile) ?? '').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line) as Wake)
  if (wakes.some(w => !w || !Number.isSafeInteger(w.seq) || w.seq < 1) || new Set(wakes.map(w => w.seq)).size !== wakes.length) {
    throw new Error(`Invalid wakes in ${home.wakesFile}`)
  }
  const cursor = json<Cursor>(home.wakesAckFile, { through: 0 })
  if (!cursor || !Number.isSafeInteger(cursor.through) || cursor.through < 0) throw new Error(`Invalid cursor in ${home.wakesAckFile}`)
  return { home, tasks: rows(home.tasksFile), backlog: rows(home.backlogFile), decisions: rows(home.decisionsFile), wakes, cursor }
}

function append<T extends { id: string }>(target: T[], row: T, file: string): void {
  if (target.some(existing => existing.id === row.id)) throw new Error(`Project migration ID collision: ${row.id} in ${file}`)
  target.push(row)
}

/** Run before any service caches or supervisors exist. The durable plan is replayed
 * after an interrupted write, then marked complete before normal startup resumes.
 * Existing unit paths stay valid: their briefs and resumed sessions may still write
 * there. Only ownership changes; worktrees and provider sessions are never moved.
 */
export function migrateProjectData(main: Home): void {
  const checkpoint = path.join(main.state, 'project-data-migration-v1.json')
  let migration = json<Migration | undefined>(checkpoint, undefined)
  if (migration?.completedAt) return

  // Every planned path must belong to this base, including journal replay.
  const relative = (file: string): string => {
    const rel = path.relative(main.root, path.resolve(file))
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`Project migration path is outside the base: ${file}`)
    }
    return rel
  }

  if (!migration) {
    const projects = json<Project[]>(main.projectsFile, [])
    const allies = json<Ally[]>(main.alliesFile, [])
    if (!Array.isArray(projects) || !Array.isArray(allies)) throw new Error('Invalid project or ally registry; migration stopped.')
    const sources = [records(main), ...allies.filter(a => !a.retiredAt).map(a => {
      relative(a.home)
      return records(new Home(a.home, a.name, main))
    })]
    const owners = new Map<string, Records>()
    const writes = new Map<string, string>()
    const setJson = (file: string, value: unknown): void => { writes.set(file, JSON.stringify(value, null, 2) + '\n') }

    for (const project of projects) {
      if (!project || typeof project.name !== 'string' || !project.name) throw new Error('Invalid project name; migration stopped.')
      let ally = allies.find(a => !a.retiredAt && a.projects.length === 1 && a.projects[0] === project.name)
      if (!ally) {
        const req = worldAllyRequest(project.name)
        const base = allyNameForWorld(project.name)
        // Retired bases and unregistered directories are archives, never reusable names.
        for (let n = 2; allies.some(a => a.name === req.name) || fs.existsSync(main.workspaceHome(req.name)); n++) {
          req.name = `${base.slice(0, 26)}-${n}`
        }
        ally = { ...req, home: main.workspaceHome(req.name), createdAt: nowIso() }
        allies.push(ally)
        const home = new Home(ally.home, ally.name, main)
        sources.push(records(home))
        writes.set(path.join(home.data, 'charter.md'), allyCharterFile(ally.name, ally.scope, ally.charter, ally.projects))
        setJson(path.join(home.root, '.genio-ally'), { name: ally.name, parent: main.root, createdAt: ally.createdAt })
      }
      owners.set(project.name, sources.find(s => s.home.name === ally.name)!)
    }

    // Resolve links against the original records, before transferring any rows.
    const taskProjects = new Map(sources.map(s => [s, new Map(s.tasks.map(t => [t.id, t.project]))]))
    const scope = (source: Records): string | undefined => allies.find(a => !a.retiredAt && a.name === source.home.name && a.projects.length === 1)?.projects[0]
    const questProjects = new Map(sources.map(s => [s, new Map(s.backlog.map(q => [q.id,
      q.project ?? (q.taskId ? taskProjects.get(s)!.get(q.taskId) : undefined) ?? s.tasks.find(t => t.backlogId === q.id)?.project
        ?? scope(s)
    ]))]))
    const nextSeq = new Map(sources.map(s => [s, s.wakes.reduce((max, w) => Math.max(max, w.seq), s.cursor.through)]))
    for (const source of sources) {
      source.tasks = source.tasks.filter(task => {
        const target = owners.get(task.project)
        if (!target || target === source) return true
        append(target.tasks, { ...task, workspace: target.home.name, storageRoot: task.storageRoot ?? source.home.root }, target.home.tasksFile)
        return false
      })
      source.backlog = source.backlog.flatMap(quest => {
        const project = questProjects.get(source)!.get(quest.id)
        const target = project && owners.get(project)
        if (!target) return [quest]
        if (target === source) return [{ ...quest, project }]
        append(target.backlog, { ...quest, project }, target.home.backlogFile)
        return []
      })
      source.decisions = source.decisions.flatMap(decision => {
        const project = decision.project ?? (decision.taskId ? taskProjects.get(source)!.get(decision.taskId) : undefined)
          ?? (decision.backlogId ? questProjects.get(source)!.get(decision.backlogId) : undefined) ?? scope(source)
        const target = project && owners.get(project)
        if (!target) return [decision]
        if (target === source) return [{ ...decision, project, workspace: target.home.name }]
        append(target.decisions, { ...decision, project, workspace: target.home.name }, target.home.decisionsFile)
        return []
      })
      for (const wake of [...source.wakes]) {
        const project = wake.taskId && taskProjects.get(source)!.get(wake.taskId)
        const target = project && owners.get(project)
        if (!target || target === source) continue
        const seq = nextSeq.get(target)! + 1
        nextSeq.set(target, seq)
        target.wakes.push({ ...wake, seq, workspace: target.home.name })
        // Carry both contiguous and per-event acknowledgements into the new sequence.
        if (wake.seq <= source.cursor.through || source.cursor.events?.[wake.seq]) {
          target.cursor.events = { ...target.cursor.events, [seq]: source.cursor.events?.[wake.seq] ?? source.cursor.at ?? nowIso() }
        }
        // Keep the source sequence history, acknowledging the transfer only in
        // the same durable transaction. Removed rows could reuse an old sequence.
        if (wake.seq > source.cursor.through) {
          source.cursor.events = { ...source.cursor.events, [wake.seq]: source.cursor.events?.[wake.seq] ?? nowIso() }
        }
      }
    }
    const allQuests = new Map(sources.flatMap(s => s.backlog).map(q => [q.id, q]))
    for (const source of sources) {
      setJson(source.home.tasksFile, source.tasks)
      setJson(source.home.backlogFile, source.backlog)
      writes.set(path.join(source.home.data, 'backlog.md'), renderBacklogMirror(source.home, source.backlog, id => allQuests.get(id)))
      setJson(source.home.decisionsFile, source.decisions)
      writes.set(source.home.wakesFile, source.wakes.map(w => JSON.stringify(w)).join('\n') + (source.wakes.length ? '\n' : ''))
      setJson(source.home.wakesAckFile, source.cursor)
    }
    setJson(main.alliesFile, allies)
    migration = { version: 1, startedAt: nowIso(), writes: [...writes].map(([file, after]) => ({ file: relative(file), before: contents(file), after }))
      .filter(write => write.before !== write.after) }
    // Backups and the complete intended result reach disk before any authoritative file changes.
    writeJsonAtomic(checkpoint, migration)
  }

  if (migration.version !== 1 || !Array.isArray(migration.writes)) throw new Error('Invalid project migration checkpoint.')
  for (const write of migration.writes) {
    const file = path.resolve(main.root, write.file)
    relative(file)
    const current = contents(file)
    if (current !== write.before && current !== write.after) {
      throw new Error(`Project migration cannot resume: ${file} changed after its backup.`)
    }
  }
  for (const write of migration.writes) {
    const file = path.resolve(main.root, write.file)
    relative(file)
    writeText(`${file}.migration-tmp`, write.after)
    fs.renameSync(`${file}.migration-tmp`, file)
  }
  writeJsonAtomic(checkpoint, { ...migration, completedAt: nowIso() })
}
