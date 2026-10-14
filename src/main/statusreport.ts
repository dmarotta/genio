/**
 * /status — the status report (companion /bearings). Exactly four sections,
 * always rendered, in this order: Your Move, Loot, In Progress, Up Next.
 * Read-only: it gathers state from every base and never changes anything.
 */
import path from 'node:path'
import type { BacklogItem, Decision, StatusLine, StatusReport, Task } from '@shared/types'
import { questOrder } from '@shared/quest-board'
import type { AppCtx, HomeCtx, StatusReportService } from './services'
import { nowIso, todayStamp, truncate, writeText } from './util'

const LOOT_WINDOW_MS = 7 * 86_400_000
const TERMINAL = new Set<Task['state']>(['merged', 'cleaned', 'done'])

const EMPTY = {
  yourMove: 'Nothing needs your move right now.',
  loot: 'No recent loot.',
  inProgress: 'Nothing in progress.',
  upNext: 'Nothing queued.'
}

const kindLabel = (t: Task): string => (t.kind === 'scout' ? 'RECON' : 'BUILD')

function recent(iso?: string): boolean {
  return Boolean(iso) && Date.now() - Date.parse(iso as string) <= LOOT_WINDOW_MS
}

function shortDate(iso: string): string {
  return iso.slice(0, 10)
}

export function createStatusReportService(getCtx: () => AppCtx): StatusReportService {
  return {
    async generate(opts) {
      const ctx = getCtx()
      const homes: HomeCtx[] = [...ctx.homes.values()]
      const yourMove: StatusLine[] = []
      const loot: StatusLine[] = []
      const inProgress: StatusLine[] = []
      const upNext: StatusLine[] = []
      const base = (h: HomeCtx): string => (h.home.name === 'main' ? '' : ` [base ${h.home.name}]`)

      for (const h of homes) {
        const tasks = safe(() => h.crew.list(), [] as Task[])
        const decisions = safe(() => h.decisions.list(false), [] as Decision[])
        const quests = safe(() => h.backlog.list(), [] as BacklogItem[])
        const taskById = new Map(tasks.map((t) => [t.id, t]))

        // ---------------- Your Move
        for (const d of decisions) {
          const t = d.taskId ? taskById.get(d.taskId) : undefined
          const where = t ? ` (${kindLabel(t)} "${t.title}")` : d.project ? ` (${d.project})` : ''
          const rec = d.recommendation ? ` — recommended: ${d.recommendation}` : ''
          yourMove.push({ text: `Choice${where}${base(h)}: ${d.question}${rec}`, decisionId: d.id, taskId: d.taskId, tone: 'amber' })
        }
        for (const q of quests) {
          if (!q.hold || q.state === 'done' || q.state === 'dropped') continue
          if (safe(() => h.backlog.bucket(q), 'none') !== 'live') continue
          yourMove.push({ text: `Quest "${q.title}"${base(h)} waits on you: ${q.hold.reason}`, backlogId: q.id, tone: 'amber' })
        }
        for (const t of tasks) {
          if (t.state !== 'ready' || t.kind !== 'ship' || t.yolo) continue
          if (t.pr?.url) {
            const checks = t.pr.checks && t.pr.checks !== 'none' ? ` · checks ${t.pr.checks}` : ''
            yourMove.push({
              text: `Build "${t.title}" (${t.project})${base(h)} is ready to merge${checks}: ${t.pr.url}`,
              taskId: t.id,
              url: t.pr.url,
              tone: t.pr.checks === 'failing' ? 'alert' : 'volt'
            })
          } else if (t.mode === 'local-only') {
            yourMove.push({
              text: `Build "${t.title}" (${t.project})${base(h)} is ready in local branch ${t.branch} — approve the merge`,
              taskId: t.id,
              tone: 'volt'
            })
          } else {
            yourMove.push({ text: `Build "${t.title}" (${t.project})${base(h)} is ready for review`, taskId: t.id, tone: 'volt' })
          }
        }

        // ---------------- Loot
        const lootTaskIds = new Set<string>()
        for (const t of tasks) {
          const when = t.cleanedAt ?? t.landedAt ?? t.updatedAt
          if (!TERMINAL.has(t.state) || !recent(when)) continue
          lootTaskIds.add(t.id)
          if (t.kind === 'scout') {
            loot.push({ text: `Recon "${t.title}" (${t.project})${base(h)} report delivered ${shortDate(when)}`, taskId: t.id, tone: 'violet' })
          } else {
            const how = t.pr?.url ? ` — ${t.pr.url}` : t.mode === 'local-only' ? ` — merged locally` : ''
            const verb = t.state === 'done' ? 'finished' : 'landed'
            loot.push({ text: `Build "${t.title}" (${t.project})${base(h)} ${verb} ${shortDate(when)}${how}`, taskId: t.id, url: t.pr?.url, tone: 'volt' })
          }
        }
        for (const q of quests) {
          if (q.state !== 'done' || !recent(q.doneAt ?? q.updatedAt)) continue
          if (q.taskId && lootTaskIds.has(q.taskId)) continue
          const out = q.outcome ? `: ${truncate(q.outcome.replace(/\s+/g, ' '), 160)}` : ''
          loot.push({ text: `Quest "${q.title}"${base(h)} done ${shortDate(q.doneAt ?? q.updatedAt)}${out}`, backlogId: q.id, tone: 'volt' })
        }

        // ---------------- In Progress
        for (const t of tasks) {
          if (TERMINAL.has(t.state)) continue
          if (t.state === 'ready' && t.kind === 'ship' && !t.yolo) continue // already in Your Move
          let detail = ''
          try {
            detail = await h.crew.crewState(t.id)
          } catch {
            detail = `state: ${t.state}`
          }
          const tone: StatusLine['tone'] = ['failed', 'exited', 'stale', 'blocked'].includes(t.state)
            ? 'alert'
            : t.state === 'needs-decision'
              ? 'amber'
              : t.kind === 'scout'
                ? 'violet'
                : 'neon'
          const pr = t.pr?.url ? ` · ${t.pr.url}` : ''
          inProgress.push({
            text: `${kindLabel(t)} "${t.title}" (${t.project})${base(h)} — ${truncate(detail.replace(/\s+/g, ' '), 200)}${pr}`,
            taskId: t.id,
            url: t.pr?.url,
            tone
          })
        }

        // ---------------- Up Next
        const ready = new Set(safe(() => h.backlog.dispatchable().map((q) => q.id), [] as string[]))
        for (const q of [...quests].sort(questOrder)) {
          if ((q.state === 'queued' || q.state === 'blocked') && !q.hold) {
            const world = q.project ? ` (${q.project})` : ''
            let why = ''
            const wait = ready.has(q.id) ? undefined : safe(() => ctx.dispatch.quotaWait(q), undefined)
            if (ready.has(q.id)) why = ' — ready to deploy'
            else if (wait) why = ` — queued until reset: ${wait.reason}${wait.until ? ` (${shortDate(wait.until)})` : ''}`
            else if (q.duplicateOf) why = ` — flagged as a duplicate of ${q.duplicateOf}`
            else if (q.dependsOn.length) why = ` — waiting on ${q.dependsOn.join(', ')}`
            else if (q.notBefore && Date.parse(q.notBefore) > Date.now()) why = ` — not before ${shortDate(q.notBefore)}`
            else if (q.project) why = ' — at capacity (project or Usage mode unit cap)'
            const prio = q.priority !== 'normal' ? ` [${q.priority}]` : ''
            upNext.push({ text: `Quest "${q.title}"${world}${base(h)}${prio}${why}`, backlogId: q.id, tone: ready.has(q.id) ? 'neon' : undefined })
          } else if ((q.state === 'queued' || q.state === 'blocked') && q.hold) {
            const b = safe(() => h.backlog.bucket(q), 'none')
            if (b === 'live') continue
            const note =
              b === 'dated'
                ? `deferred until ${shortDate(q.hold.until ?? '')}`
                : b === 'aged'
                  ? `held 14+ days: ${q.hold.reason}`
                  : `blocked: ${q.hold.reason}`
            upNext.push({ text: `Quest "${q.title}"${base(h)} — ${note}`, backlogId: q.id, tone: b === 'blocked' ? 'alert' : undefined })
          }
        }
      }

      // ---------------- optional live PR enrichment
      if (opts.includePRs) {
        try {
          const known = new Set(homes.flatMap((h) => safe(() => h.crew.list(), [] as Task[])).map((t) => t.pr?.url).filter(Boolean) as string[])
          const prs = await ctx.forge.myOpenPrs()
          for (const pr of prs) {
            if (known.has(pr.url)) continue
            inProgress.push({ text: `Open PR "${pr.title}" (${pr.repo}) · checks ${pr.checks}: ${pr.url}`, url: pr.url, tone: pr.checks === 'failing' ? 'alert' : 'neon' })
          }
        } catch {
          inProgress.push({ text: 'Live PR lookup unavailable (GitHub CLI missing or not signed in).', tone: 'alert' })
        }
      }

      const generatedAt = nowIso()
      const report: StatusReport = {
        generatedAt,
        yourMove,
        loot,
        inProgress,
        upNext,
        markdown: '',
        includePRs: opts.includePRs
      }
      report.markdown = renderMarkdown(report)

      if (opts.file) {
        const p = path.join(ctx.main.home.data, `status-report-${todayStamp()}.md`)
        try {
          writeText(p, report.markdown)
          report.filedPath = p
        } catch {
          /* filing failed; chat digest still returned */
        }
      }
      return report
    }
  }
}

export function renderMarkdown(r: StatusReport): string {
  const d = new Date(r.generatedAt)
  const weekday = d.toLocaleDateString('en-US', { weekday: 'long' })
  const section = (title: string, lines: StatusLine[], empty: string): string =>
    `## ${title}\n\n${lines.length ? lines.map((l) => `- ${l.text}`).join('\n') : `_${empty}_`}\n`
  return [
    `# Status - ${weekday} ${todayStamp(d)}`,
    '',
    section('Your Move', r.yourMove, EMPTY.yourMove),
    section('Loot', r.loot, EMPTY.loot),
    section('In Progress', r.inProgress, EMPTY.inProgress),
    section('Up Next', r.upNext, EMPTY.upNext)
  ].join('\n')
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}
