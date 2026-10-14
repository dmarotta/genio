/**
 * Your Move: open choices waiting on the player (companion keyed
 * needs-decision / blocked records + captain holds).
 *
 * A unit's `needs-decision [key=k]` / `blocked [key=k]` opens one choice per
 * (task, key); answering it pings the unit with the player's words and closes
 * the key with a `resolved [key=k]` status line (crew.send resolveKeys).
 * "Later" defers with `until`; a deferred choice is hidden until then.
 * A player answer given anywhere but the owning chat also wakes that chat with
 * an urgent `answer` event (followUp pending → delivered), so Genio follows
 * through at once, including on a finished Recon's choice.
 */
import type { Decision } from '@shared/types'
import { bus } from './bus'
import type { Home } from './home'
import { formatNotification } from './notify-format'
import type { AppCtx, DecisionService } from './services'
import { nowIso, readJson, rid, truncate, writeJson } from './util'

const KEEP_RESOLVED = 300

export function createDecisionService(getCtx: () => AppCtx, home: Home): DecisionService {
  let rows: Decision[] | undefined

  function load(): Decision[] {
    if (!rows) {
      const raw = readJson<Decision[]>(home.decisionsFile, [])
      rows = Array.isArray(raw) ? raw.filter((d) => d && typeof d.id === 'string') : []
    }
    return rows
  }

  function isOpen(d: Decision): boolean {
    if (d.resolvedAt) return false
    if (d.until && Date.parse(d.until) > Date.now()) return false
    return true
  }

  function save(): void {
    const all = load()
    const resolved = all.filter((d) => d.resolvedAt)
    if (resolved.length > KEEP_RESOLVED) {
      const drop = new Set(
        resolved
          .sort((a, b) => (a.resolvedAt ?? '').localeCompare(b.resolvedAt ?? ''))
          .slice(0, resolved.length - KEEP_RESOLVED)
          .map((d) => d.id)
      )
      rows = all.filter((d) => !drop.has(d.id))
    }
    try {
      writeJson(home.decisionsFile, rows)
    } catch {
      /* keep in memory */
    }
    publish()
  }

  function publish(): void {
    let merged: Decision[] = load()
    try {
      const ctx = getCtx()
      merged = [...ctx.homes.values()].flatMap((h) => (h.home.name === home.name ? load() : h.decisions.list(true)))
      if (!ctx.homes.has(home.name)) merged = [...merged, ...load()]
    } catch {
      /* not wired */
    }
    bus.publish({ type: 'decisions', decisions: merged })
  }

  function announce(d: Decision): void {
    try {
      const ctx = getCtx()
      ctx.notifier.sfx('decision')
      const mode = ctx.away.state().mode
      const target = { view: 'move' as const, project: d.project, wksp: d.wksp, decisionId: d.id }
      const where = d.taskId ? ` (${d.taskId})` : ''
      if (mode === 'dnd' || mode === 'afk') {
        ctx.away.capture({ wksp: home.name, text: `Your move${where}: ${d.question}`, severity: 'decision', where: d.project, target })
      } else {
        const { title, body } = formatNotification({ kind: 'decision', text: d.question, where: d.project ?? home.name })
        ctx.notifier.notify(title, body, 'decision', { target })
      }
      ctx.ledger.record({ home: home.name, event: 'decision.opened', task: d.taskId, project: d.project, data: { id: d.id, key: d.key, question: d.question, source: d.source } })
    } catch {
      /* not wired */
    }
  }

  const svc: DecisionService = {
    list(includeResolved = false) {
      const all = load()
      return (includeResolved ? all : all.filter(isOpen)).slice().sort((a, b) => {
        if (a.urgency !== b.urgency) return a.urgency === 'urgent' ? -1 : 1
        return a.createdAt.localeCompare(b.createdAt)
      })
    },

    get(id) {
      return load().find((d) => d.id === id)
    },

    open(input) {
      const d: Decision = {
        id: input.id && !load().some((x) => x.id === input.id) ? input.id : `ch-${rid(8)}`,
        key: (input.key ?? 'default').trim() || 'default',
        wksp: home.name,
        taskId: input.taskId,
        backlogId: input.backlogId,
        project: input.project ?? projectOf(input.taskId) ?? questProject(input.backlogId) ?? ownerProject(),
        question: input.question.trim(),
        context: input.context,
        options: Array.isArray(input.options) ? input.options.filter(Boolean) : [],
        recommendation: input.recommendation,
        batch: input.batch,
        source: input.source ?? 'genio',
        urgency: input.urgency ?? 'normal',
        createdAt: nowIso(),
        revision: 1,
        ...(input.until ? { until: input.until } : {}),
        ...(input.action ? { action: input.action } : {})
      }
      load().push(d)
      save()
      announce(d)
      return d
    },

    openForTask(taskId, key, question, source, extra) {
      const k = (key || 'default').trim() || 'default'
      const existing = load().find((d) => d.taskId === taskId && d.key === k && !d.resolvedAt)
      if (existing) {
        let changed = false
        if (question && existing.question !== question.trim()) {
          existing.question = question.trim()
          changed = true
        }
        if (extra) {
          for (const f of ['context', 'recommendation', 'options', 'urgency', 'batch'] as const) {
            if (extra[f] !== undefined && JSON.stringify(existing[f]) !== JSON.stringify(extra[f])) {
              ;(existing as unknown as Record<string, unknown>)[f] = extra[f]
              changed = true
            }
          }
        }
        if (changed) {
          existing.revision = (existing.revision ?? 0) + 1
          save()
        }
        return existing
      }
      return svc.open({ ...extra, taskId, key: k, question, source })
    },

    resolve(id, answer, options) {
      const d = load().find((x) => x.id === id)
      if (!d) return undefined
      if (d.resolvedAt) return d
      answer = answer.trim()
      if (!answer) throw new Error('An answer is required.')
      if (d.until && Date.parse(d.until) > Date.now()) throw new Error('This choice is deferred. Resume it before answering.')
      let ctx: AppCtx | undefined
      try {
        ctx = getCtx()
      } catch {
        ctx = undefined
      }
      d.resolvedAt = nowIso()
      d.answer = answer
      delete d.until
      // Typed into the owning chat, the answer is already there; anywhere else it must be carried to it.
      const origin = options?.origin
      if (origin && !(origin.via === 'chat' && origin.chat === ownerName(ctx, d))) d.followUp = 'pending'
      save()
      if (ctx) {
        try { receipt(ctx, d, answer) } catch { /* optional chat receipt */ }
        if (d.action) {
          try {
            ctx.dispatch.answered(d, answer)
          } catch {
            /* a failed apply never blocks the answer */
          }
        }
        // Relay the player's words to the unit that asked; closes the key.
        if (options?.relay !== false && d.taskId) {
          const h = safeHome(ctx, home.name)
          const task = h?.crew.get(d.taskId)
          if (h && task && !['cleaned', 'done', 'merged'].includes(task.state)) {
            void h.crew
              .send(d.taskId, `Answer to your open choice [key=${d.key}]: ${answer}`, [d.key])
              .catch(() => undefined)
          }
        }
        if (d.backlogId) {
          try {
            const h = safeHome(ctx, home.name)
            const q = h?.backlog.get(d.backlogId)
            if (h && q && q.state === 'held') h.backlog.answer(d.backlogId, answer, true)
          } catch {
            /* quest may be gone */
          }
        }
        try {
          ctx.stats.award('decision', d.taskId)
          ctx.ledger.record({ home: home.name, event: 'decision.resolved', task: d.taskId, project: d.project, data: { id: d.id, key: d.key, answer } })
        } catch {
          /* optional */
        }
        // Still pending on failure: the next project open delivers it.
        if (d.followUp === 'pending') try { deliverAnswer(ctx, d) } catch { /* retried on project open */ }
      }
      return d
    },

    deliverAnswers(project) {
      let ctx: AppCtx
      try {
        ctx = getCtx()
      } catch {
        return 0
      }
      let count = 0
      for (const d of load()) {
        if (d.followUp !== 'pending' || d.project !== project) continue
        try {
          if (deliverAnswer(ctx, d)) count++
        } catch {
          /* stays pending for the next open */
        }
      }
      return count
    },

    clarify(id, question) {
      const d = load().find(x => x.id === id && !x.resolvedAt)
      if (!d) return
      d.clarifications = [...(d.clarifications ?? []), { question, at: nowIso() }]
      d.revision = (d.revision ?? 0) + 1
      save()
    },

    resolveKey(taskId, key, answer) {
      const k = (key || 'default').trim() || 'default'
      let changed = false
      for (const d of load()) {
        if (d.taskId === taskId && d.key === k && !d.resolvedAt) {
          d.resolvedAt = nowIso()
          d.answer = answer
          delete d.until
          try { receipt(getCtx(), d, answer ?? '') } catch { /* not wired */ }
          changed = true
        }
      }
      if (changed) {
        save()
        try {
          getCtx().ledger.record({ home: home.name, event: 'decision.resolved', task: taskId, data: { key: k, answer } })
        } catch {
          /* optional */
        }
      }
    },

    defer(id, until) {
      const d = load().find((x) => x.id === id)
      if (!d || d.resolvedAt) return
      if (until && !Number.isFinite(Date.parse(until))) throw new Error('Invalid deferral date.')
      if ((d.until ?? '') === (until ?? '')) return
      d.revision = (d.revision ?? 0) + 1
      if (until) d.until = until
      else delete d.until // resurface now
      save()
    }
  }

  function questProject(id?: string): string | undefined {
    try { return id ? getCtx().home(home.name).backlog.get(id)?.project : undefined }
    catch { return undefined }
  }

  function ownerProject(): string | undefined {
    try { return getCtx().allies.list().find(a => a.name === home.name && !a.retiredAt)?.projects[0] }
    catch { return undefined }
  }

  /** The chat that owns a choice: the live Ally of its project, else this base. */
  function ownerName(ctx: AppCtx | undefined, d: Decision): string {
    try {
      return (d.project && ctx?.allies.list().find(a => !a.retiredAt && a.projects.includes(d.project!))?.name) || home.name
    } catch {
      return home.name
    }
  }

  function receipt(ctx: AppCtx, d: Decision, answer: string): void {
    safeHome(ctx, ownerName(ctx, d))?.wksp.say(`Answered: ${d.question}\n\n${answer}`, 'system')
  }

  /**
   * Carry a player's answer to the owning chat as an urgent durable event, so
   * it follows through without waiting for the player to type. Once only: the
   * wake queue survives restarts and is acked after handling; the visible
   * receipt was already written at resolve time.
   */
  function deliverAnswer(ctx: AppCtx, d: Decision): boolean {
    const owner = safeHome(ctx, ownerName(ctx, d))
    if (!owner) return false
    const tag = `Player answered choice ${d.id} `
    if (!owner.wakes.recent(0).some(w => w.kind === 'answer' && w.reason.startsWith(tag))) {
      const found = d.taskId ? [...ctx.homes.values()].map(h => h.crew.get(d.taskId!)).find(Boolean) : undefined
      const quest = d.backlogId ? [...ctx.homes.values()].map(h => h.backlog.get(d.backlogId!)).find(Boolean) : undefined
      const on = found ? `${found.kind === 'scout' ? 'Recon' : 'Build'} "${found.title}"` : quest ? `quest "${quest.title}"` : `"${truncate(d.question, 120)}"`
      const unitDone = !found || ['cleaned', 'done', 'merged'].includes(found.state)
      const lines = [
        `Question: ${d.question}`,
        ...(d.options.length ? [`Options: ${d.options.join(' | ')}`] : []),
        ...(d.recommendation ? [`Recommendation: ${d.recommendation}`] : []),
        ...(found ? [`Unit ${found.id} (${found.state})${found.reportPath ? `; report: ${found.reportPath.replace(/\\/g, '/')}` : ''}`] : []),
        ...(quest ? [`Quest ${quest.id}: ${quest.title} (${quest.state})`] : []),
        found && !unitDone
          ? 'The unit was pinged with this answer and carries on; act only where the answer needs other work.'
          : 'Follow through now: carry out the chosen option (file and deploy the work, respecting dependencies and serial order; queue the rest) with the player\'s words as intent, then report.',
        'The player already sees an "Answered" receipt in this chat; do not echo the answer back.'
      ]
      owner.wakes.enqueue({ kind: 'answer', reason: `${tag}[${d.key}] on ${on}: ${truncate(d.answer ?? '', 400)}`, taskId: d.taskId, lines, routine: false })
    }
    d.followUp = 'delivered'
    save()
    try {
      owner.wksp.deliverWakes()
    } catch {
      /* the durable queue is delivered when the chat is ready */
    }
    return true
  }

  function projectOf(taskId?: string): string | undefined {
    if (!taskId) return undefined
    try {
      return getCtx().home(home.name).crew.get(taskId)?.project
    } catch {
      return undefined
    }
  }

  return svc
}

function safeHome(ctx: AppCtx, name: string) {
  try {
    return ctx.home(name)
  } catch {
    return undefined
  }
}
