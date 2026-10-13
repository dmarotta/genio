/**
 * Quest Log (companion backlog contract, AGENTS.md §10 + fm-captain-hold.sh).
 *
 * The durable queue of work items. It tracks work, never agents. A player
 * choice is simply a quest held for the player (PlayerHold); "later" is a
 * re-hold with `until`. Dispatch happens only when dependencies are done,
 * time gates passed, the item is not held, and the world has capacity.
 *
 * Storage: data/backlog.json (authoritative) + data/backlog.md (human mirror,
 * companion row format) + data/done-archive.md (append-only older loot).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { BacklogItem, BacklogState, Priority } from '@shared/types'
import { bus } from './bus'
import type { Home } from './home'
import type { AppCtx, BacklogService } from './services'
import { nowIso, readJson, readText, rid, slugify, writeJson, writeText } from './util'

const AGED_DAYS = 14
const DONE_KEEP_MD = 10
const DONE_KEEP_JSON = 300
const MAX_ANSWER_BYTES = 8192
const PRIORITY_RANK: Record<Priority, number> = { critical: 0, high: 1, normal: 2, low: 3 }

export function createBacklogService(getCtx: () => AppCtx, home: Home): BacklogService {
  let items: BacklogItem[] | undefined

  const mdFile = (): string => path.join(home.data, 'backlog.md')
  const archiveFile = (): string => path.join(home.data, 'done-archive.md')

  function load(): BacklogItem[] {
    if (!items) {
      const raw = readJson<BacklogItem[]>(home.backlogFile, [])
      items = Array.isArray(raw) ? raw.filter((i) => i && typeof i.id === 'string').map(normalize) : []
    }
    return items
  }

  function save(): void {
    const all = load()
    // Bound the JSON: very old done/dropped rows live on in the archive.
    const closed = all.filter((i) => i.state === 'done' || i.state === 'dropped')
    if (closed.length > DONE_KEEP_JSON) {
      const drop = new Set(
        closed
          .sort((a, b) => (a.doneAt ?? a.updatedAt).localeCompare(b.doneAt ?? b.updatedAt))
          .slice(0, closed.length - DONE_KEEP_JSON)
          .map((i) => i.id)
      )
      archive(all.filter((i) => drop.has(i.id)))
      items = all.filter((i) => !drop.has(i.id))
    }
    try {
      writeJson(home.backlogFile, items)
    } catch {
      /* in-memory state survives until the next successful write */
    }
    try {
      writeMirror()
    } catch {
      /* mirror is a convenience */
    }
    publish()
  }

  function publish(): void {
    let merged: BacklogItem[] = load()
    try {
      const ctx = getCtx()
      merged = [...ctx.homes.values()].flatMap((h) => (h.home.name === home.name ? load() : h.backlog.list()))
      if (!ctx.homes.has(home.name)) merged = [...merged, ...load()]
    } catch {
      /* not wired (tests) */
    }
    bus.publish({ type: 'backlog', items: merged })
  }

  function ledger(event: 'backlog.added' | 'backlog.state', item: BacklogItem, data?: Record<string, unknown>): void {
    try {
      getCtx().ledger.record({ home: home.name, event, task: item.taskId, project: item.project, data: { id: item.id, title: item.title, state: item.state, ...data } })
    } catch {
      /* ledger optional */
    }
  }

  function must(id: string): BacklogItem {
    const it = load().find((i) => i.id === id)
    if (!it) throw new Error(`no quest with id "${id}"`)
    return it
  }

  function uniqueId(title: string): string {
    const base = slugify(title, 24)
    const taken = new Set(load().map((i) => i.id))
    for (let n = 0; n < 50; n++) {
      const id = `${base}-${rid(2)}`
      if (!taken.has(id)) return id
    }
    return `${base}-${rid(4)}`
  }

  function setState(it: BacklogItem, state: BacklogState): void {
    if (it.state === state) return
    it.state = state
    if (state === 'done' || state === 'dropped') it.doneAt = it.doneAt ?? nowIso()
    else delete it.doneAt
    ledger('backlog.state', it)
  }

  function findAnywhere(id: string): BacklogItem | undefined {
    const own = load().find((i) => i.id === id)
    if (own) return own
    try {
      for (const h of getCtx().homes.values()) {
        if (h.home.name === home.name) continue
        const it = h.backlog.get(id)
        if (it) return it
      }
    } catch {
      /* not wired */
    }
    return undefined
  }

  function unresolvedDeps(it: BacklogItem): string[] {
    return (it.dependsOn ?? []).filter((d) => {
      const dep = findAnywhere(d)
      return !dep || dep.state !== 'done'
    })
  }

  function capacityUsed(project: string): number {
    try {
      return [...getCtx().homes.values()].reduce((n, h) => n + h.crew.capacityUsed(project), 0)
    } catch {
      return 0
    }
  }

  function usageCapacity(): { cap: number; used: number } | undefined {
    try {
      return getCtx().dispatch.capacity()
    } catch {
      return undefined
    }
  }

  /** queued until a plan resets: stays queued, just not offered for automatic dispatch */
  function waitsForQuota(it: BacklogItem): boolean {
    try {
      return Boolean(getCtx().dispatch.quotaWait(it))
    } catch {
      return false
    }
  }

  function capacityOf(project: string): number {
    try {
      return getCtx().projects.get(project)?.capacity ?? 0
    } catch {
      return 0
    }
  }

  // ------------------------------------------------------------- mirror

  function row(i: BacklogItem): string {
    const done = i.state === 'done' || i.state === 'dropped'
    const bits: string[] = [`- [${done ? 'x' : ' '}] ${i.id} - ${i.title}`]
    const deps = unresolvedDeps(i)
    if (deps.length && !done) bits.push(`[blocked-by: ${deps.join(', ')}]`)
    if (i.project) bits.push(`(world: ${i.project})`)
    bits.push(`(kind: ${i.kind})`)
    if (i.priority !== 'normal') bits.push(`(priority: ${i.priority})`)
    if (i.taskId) bits.push(`(mission: ${i.taskId})`)
    if (i.notBefore && !done) bits.push(`(not-before: ${i.notBefore.slice(0, 10)})`)
    if (i.hold && !done) {
      bits.push(`(hold: ${i.hold.reason})`)
      if (i.hold.until) bits.push(`(hold-until: ${i.hold.until.slice(0, 10)})`)
    }
    if (done) bits.push(`(${i.state === 'dropped' ? 'dropped' : 'done'} ${(i.doneAt ?? i.updatedAt).slice(0, 10)})`)
    else bits.push(`(since ${i.createdAt.slice(0, 10)})`)
    const lines = [bits.join(' ')]
    if (i.outcome) lines.push(`  Outcome: ${i.outcome.replace(/\r?\n/g, '\n  ')}`)
    if (i.answer) lines.push(`  Player answer: ${i.answer.replace(/\r?\n/g, '\n  ')}`)
    if (i.hold && !done) lines.push(`  Player hold set: ${i.hold.since}`)
    if (i.notes?.trim()) lines.push(...i.notes.trim().split(/\r?\n/).map((l) => `  ${l}`))
    return lines.join('\n')
  }

  function writeMirror(): void {
    const all = load()
    const byPrio = (a: BacklogItem, b: BacklogItem): number =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt.localeCompare(b.createdAt)
    const inFlight = all.filter((i) => i.state === 'in-flight').sort(byPrio)
    const queued = all.filter((i) => i.state === 'queued' || i.state === 'blocked').sort(byPrio)
    const held = all.filter((i) => i.state === 'held').sort(byPrio)
    const done = all
      .filter((i) => i.state === 'done' || i.state === 'dropped')
      .sort((a, b) => (b.doneAt ?? b.updatedAt).localeCompare(a.doneAt ?? a.updatedAt))
    const recent = done.slice(0, DONE_KEEP_MD)
    archive(done.slice(DONE_KEEP_MD))
    const section = (title: string, list: BacklogItem[]): string =>
      `## ${title}\n\n${list.length ? list.map(row).join('\n') : '_none_'}\n`
    const md = [
      `# Quest Log${home.isMain ? '' : ` - ${home.name}`}`,
      '',
      `_Mirror of backlog.json, regenerated by Genio. Edit through the app._`,
      '',
      section('In flight', inFlight),
      section('Queued', queued),
      section('Held', held),
      section('Done', recent)
    ].join('\n')
    writeText(mdFile(), md)
  }

  /** append-only archive of older loot; never duplicates an id */
  function archive(list: BacklogItem[]): void {
    if (!list.length) return
    const existing = readText(archiveFile())
    const fresh = list.filter((i) => !existing.includes(`] ${i.id} - `))
    if (!fresh.length) return
    const header = existing ? '' : `# Done archive\n\n`
    try {
      fs.mkdirSync(path.dirname(archiveFile()), { recursive: true })
      fs.appendFileSync(archiveFile(), header + fresh.map(row).join('\n') + '\n', 'utf8')
    } catch {
      /* archive is best effort */
    }
  }

  // ------------------------------------------------------------- service

  const svc: BacklogService = {
    list() {
      return load().slice()
    },

    get(id) {
      return load().find((i) => i.id === id)
    },

    add(input) {
      const ts = nowIso()
      const it: BacklogItem = normalize({
        id: input.id && !load().some((i) => i.id === input.id) ? input.id : uniqueId(input.title),
        title: input.title.trim() || 'untitled quest',
        project: input.project,
        kind: input.kind ?? 'ship',
        notes: input.notes ?? '',
        state: input.state ?? (input.hold ? 'held' : 'queued'),
        priority: input.priority ?? 'normal',
        dependsOn: input.dependsOn ?? [],
        notBefore: input.notBefore,
        hold: input.hold,
        origin: input.origin,
        taskId: input.taskId,
        mode: input.mode,
        yolo: input.yolo,
        tags: input.tags ?? [],
        createdAt: ts,
        updatedAt: ts,
        outcome: input.outcome
      })
      load().push(it)
      ledger('backlog.added', it)
      bus.publish({ type: 'feature-used', feature: 'quest_add' })
      save()
      return it
    },

    update(id, patch) {
      const it = must(id)
      const { id: _ignore, createdAt: _c, ...rest } = patch
      const nextState = rest.state
      delete (rest as Partial<BacklogItem>).state
      Object.assign(it, rest)
      if (nextState) setState(it, nextState)
      if (it.state !== 'held' && it.hold && nextState && nextState !== 'held') delete it.hold
      it.updatedAt = nowIso()
      Object.assign(it, normalize(it))
      save()
      return it
    },

    remove(id) {
      const all = load()
      const idx = all.findIndex((i) => i.id === id)
      if (idx < 0) return
      all.splice(idx, 1)
      save()
    },

    hold(id, reason, until) {
      const it = must(id)
      const sameReason = it.hold && it.hold.reason === reason && it.hold.until === until
      if (sameReason && it.state === 'held') return it // idempotent
      it.hold = { reason: reason.trim() || 'waiting on the player', since: it.hold?.since ?? nowIso(), ...(until ? { until } : {}) }
      setState(it, 'held')
      it.updatedAt = nowIso()
      save()
      return it
    },

    answer(id, words, release) {
      const it = must(id)
      let w = words
      while (Buffer.byteLength(w, 'utf8') > MAX_ANSWER_BYTES) w = w.slice(0, Math.floor(w.length * 0.9))
      it.answer = w
      delete it.hold
      if (release && (it.kind === 'ship' || it.kind === 'scout')) {
        setState(it, it.taskId && taskLive(it.taskId) ? 'in-flight' : 'queued')
      } else {
        it.outcome = it.outcome ? `${it.outcome}\nAnswer: ${w}` : w
        setState(it, 'done')
      }
      it.updatedAt = nowIso()
      save()
      return it
    },

    release(id) {
      const it = must(id)
      delete it.hold
      if (it.state === 'held') setState(it, it.taskId && taskLive(it.taskId) ? 'in-flight' : 'queued')
      it.updatedAt = nowIso()
      save()
      return it
    },

    dispatchable() {
      const now = Date.now()
      const picked: BacklogItem[] = []
      const extra = new Map<string, number>()
      const candidates = load()
        .filter((i) => i.kind === 'ship' || i.kind === 'scout')
        .filter((i) => i.state === 'queued' || (i.state === 'held' && i.hold?.until && Date.parse(i.hold.until) <= now))
        .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt.localeCompare(b.createdAt))
      const global = usageCapacity()
      for (const it of candidates) {
        if (it.hold && !(it.hold.until && Date.parse(it.hold.until) <= now)) continue
        if (it.notBefore && Date.parse(it.notBefore) > now) continue
        if (unresolvedDeps(it).length) continue
        // the Usage mode's cap counts units in every world and base
        if (global && global.used + picked.length >= global.cap) break
        if (waitsForQuota(it)) continue
        if (it.project) {
          const cap = capacityOf(it.project)
          if (cap > 0) {
            const used = capacityUsed(it.project) + (extra.get(it.project) ?? 0)
            if (used >= cap) continue
            extra.set(it.project, (extra.get(it.project) ?? 0) + 1)
          }
        }
        picked.push(it)
      }
      return picked
    },

    bucket(item) {
      if (!item.hold || item.state === 'done' || item.state === 'dropped') return 'none'
      if (unresolvedDeps(item).length) return 'blocked'
      if (item.hold.until && Date.parse(item.hold.until) > Date.now()) return 'dated'
      const ageDays = (Date.now() - Date.parse(item.hold.since)) / 86_400_000
      if (ageDays >= AGED_DAYS) return 'aged'
      return 'live'
    },

    markInFlight(id, taskId) {
      const it = load().find((i) => i.id === id)
      if (!it) return
      it.taskId = taskId
      delete it.hold
      setState(it, 'in-flight')
      it.updatedAt = nowIso()
      save()
    },

    markDone(id, outcome) {
      const it = load().find((i) => i.id === id)
      if (!it) return
      if (outcome) it.outcome = outcome
      delete it.hold
      setState(it, 'done')
      it.updatedAt = nowIso()
      save()
    }
  }

  function taskLive(taskId: string): boolean {
    try {
      const t = getCtx().home(home.name).crew.get(taskId)
      return Boolean(t && !['cleaned', 'done', 'failed', 'merged'].includes(t.state))
    } catch {
      return false
    }
  }

  return svc
}

function normalize(i: BacklogItem): BacklogItem {
  return {
    ...i,
    notes: i.notes ?? '',
    priority: (['low', 'normal', 'high', 'critical'] as Priority[]).includes(i.priority) ? i.priority : 'normal',
    dependsOn: Array.isArray(i.dependsOn) ? i.dependsOn.filter(Boolean) : [],
    tags: Array.isArray(i.tags) ? i.tags : [],
    kind: i.kind ?? 'ship',
    state: i.state ?? 'queued',
    createdAt: i.createdAt ?? nowIso(),
    updatedAt: i.updatedAt ?? nowIso()
  }
}

