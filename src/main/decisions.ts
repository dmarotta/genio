/**
 * Your Move: open choices waiting on the player (companion keyed
 * needs-decision / blocked records + captain holds).
 *
 * A unit's `needs-decision [key=k]` / `blocked [key=k]` opens one choice per
 * (task, key); answering it pings the unit with the player's words and closes
 * the key with a `resolved [key=k]` status line (crew.send resolveKeys).
 * "Later" defers with `until`; a deferred choice is hidden until then.
 */
import type { Decision } from '@shared/types'
import { bus } from './bus'
import type { Home } from './home'
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
    let merged: Decision[] = load().filter(isOpen)
    try {
      const ctx = getCtx()
      merged = [...ctx.homes.values()].flatMap((h) => (h.home.name === home.name ? load().filter(isOpen) : h.decisions.list(false)))
      if (!ctx.homes.has(home.name)) merged = [...merged, ...load().filter(isOpen)]
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
      const where = d.taskId ? ` (${d.taskId})` : ''
      if (mode === 'dnd' || mode === 'afk') {
        ctx.away.capture({ wksp: home.name, text: `Your move${where}: ${d.question}`, severity: 'decision' })
      } else {
        ctx.notifier.notify(`Your move${where}`, truncate(d.question, 240), 'decision')
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
        id: input.id && !load().some((x) => x.id === input.id) ? input.id : `ch-${rid(3)}`,
        key: (input.key ?? 'default').trim() || 'default',
        wksp: home.name,
        taskId: input.taskId,
        backlogId: input.backlogId,
        project: input.project ?? projectOf(input.taskId),
        question: input.question.trim(),
        context: input.context,
        options: Array.isArray(input.options) ? input.options.filter(Boolean) : [],
        recommendation: input.recommendation,
        source: input.source ?? 'genio',
        urgency: input.urgency ?? 'normal',
        createdAt: nowIso(),
        ...(input.until ? { until: input.until } : {})
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
          for (const f of ['context', 'recommendation', 'options', 'urgency'] as const) {
            if (extra[f] !== undefined) {
              ;(existing as unknown as Record<string, unknown>)[f] = extra[f]
              changed = true
            }
          }
        }
        if (changed) save()
        return existing
      }
      return svc.open({ ...extra, taskId, key: k, question, source })
    },

    resolve(id, answer) {
      const d = load().find((x) => x.id === id)
      if (!d) return undefined
      if (d.resolvedAt) return d
      d.resolvedAt = nowIso()
      d.answer = answer
      delete d.until
      save()
      let ctx: AppCtx | undefined
      try {
        ctx = getCtx()
      } catch {
        ctx = undefined
      }
      if (ctx) {
        // Relay the player's words to the unit that asked; closes the key.
        if (d.taskId && (d.source === 'unit' || d.source === 'validation')) {
          const h = safeHome(ctx, home.name)
          const task = h?.crew.get(d.taskId)
          if (h && task && task.state !== 'cleaned') {
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
      }
      return d
    },

    resolveKey(taskId, key, answer) {
      const k = (key || 'default').trim() || 'default'
      let changed = false
      for (const d of load()) {
        if (d.taskId === taskId && d.key === k && !d.resolvedAt) {
          d.resolvedAt = nowIso()
          d.answer = answer
          delete d.until
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
      if (until) d.until = until
      else delete d.until // resurface now
      save()
    }
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
