/**
 * Reactions on Genio's chat messages: a like says the player confirms the
 * path, a dislike pauses what that message started and asks what is wrong.
 *
 * Every set, change or removal is logged (data/reactions.jsonl) and wakes the
 * owning chat with an urgent `reaction` event (durable, acked after handling,
 * one per reaction). A like is a confidence signal only: the dispatch
 * scorecard counts it for the units involved, and it never authorizes a merge,
 * force, spending or a destructive step. A dislike counts at once but its
 * pause waits a grace period (a cancellable timer here): undone inside it,
 * nothing is paused. Then it pauses exactly the message's action record
 * (interrupts its units, never despawning them; holds its queued quests;
 * stops Genio merging its ready work) and opens ONE choice keyed by the
 * message. Undone after the pause it was unintended: the units are relaunched
 * with a progress note, the quests released and the choice closed. Answering
 * "keep going" resumes the same way.
 */
import path from 'node:path'
import type { BacklogItem, ChatMessage, Decision, MessageActions, ReactionKind, Task } from '@shared/types'
import { bus } from './bus'
import type { Home } from './home'
import type { AppCtx, HomeCtx, ReactionService } from './services'
import { appendJsonl, nowIso, readJsonl, rid, truncate } from './util'

export const DISLIKE_GRACE_MS = 1000
export const REACTION_OPTIONS = { stop: 'Stop this work', keep: 'Keep going, I meant something else', explain: 'Let me explain' } as const
export const DISLIKE_HOLD = 'Paused by your dislike: Genio asked what is wrong'

/** One line of the durable reaction log. */
export interface ReactionEvent {
  id: string
  message: string
  workspace: string
  project?: string
  kind: ReactionKind | 'none'
  previous?: ReactionKind
  at: string
  actions?: MessageActions
  excerpt: string
}

const FINISHED: Task['state'][] = ['cleaned', 'merged', 'done', 'failed', 'exited']
/** Units a dislike stops; ready or validating work keeps its state and only waits to be merged. */
const RUNNING: Task['state'][] = ['spawning', 'working', 'stale', 'blocked', 'needs-decision', 'paused', 'detached']
const ACK = 'Reply with one very short acknowledgement (a few words).'
const LIKE_RULE = 'A like confirms this path: proceed confidently and stop re-asking about it. It never approves a merge, force, spending or a destructive step; merge approval and Auto-loot rules are unchanged.'
const BOT_RULE = 'Bot (AFK): a dislike is an escalation: escalate it (severity decision); never resume, release or answer it yourself.'

const uniq = (ids: (string | undefined)[]): string[] => [...new Set(ids.filter((x): x is string => !!x))]
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const label = (t: Task): string => `${t.kind === 'scout' ? 'Recon' : 'Build'} ${t.id} "${truncate(t.title, 60)}"`
const quest = (q: BacklogItem): string => `quest ${q.id} "${truncate(q.title, 60)}"`
const keepsGoing = (answer: string): boolean =>
  answer.trim() === REACTION_OPTIONS.keep || /^(keep going|carry on|go on|continue|never ?mind|resume)\b/i.test(answer.trim())

export function excerptOf(m: Pick<ChatMessage, 'text'>, n = 200): string {
  return truncate(m.text.replace(/\s+/g, ' ').trim(), n) || '(no text)'
}

/** "2 units and 1 quest" */
export function pauseSummary(units: number, quests: number, merges: number): string {
  const parts = [units && plural(units, 'unit'), quests && plural(quests, 'quest'), merges && plural(merges, 'merge')].filter(Boolean) as string[]
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] ?? 'nothing'
}

export function actionsLine(a: MessageActions | undefined): string {
  const parts = (['units', 'quests', 'merges', 'choices', 'settings'] as const)
    .filter(k => a?.[k]?.length).map(k => `${k} ${a![k]!.join(', ')}`)
  return parts.length ? `Action record: ${parts.join('; ')}` : 'Action record: none (that message started nothing).'
}

export function createReactionService(getCtx: () => AppCtx, home: Home): ReactionService {
  const file = path.join(home.data, 'reactions.jsonl')
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  // One reaction at a time per chat, in click order: an undo waits for the pause it undoes.
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = chain.then(run)
    chain = next.catch(() => undefined)
    return next
  }

  const hc = (): HomeCtx => getCtx().home(home.name)
  const messageOf = (id: string): ChatMessage | undefined => hc().workspace.history(5000).find(m => m.id === id)
  const save = (m: ChatMessage): ChatMessage => { hc().workspace.post(m, true); return m }
  const project = (): string | undefined => safe(() => getCtx().allies.list().find(a => a.name === home.name && !a.retiredAt)?.projects[0])
  const deliver = (): void => { try { hc().workspace.deliverWakes() } catch { /* the durable queue waits for the chat */ } }

  function enqueue(tag: string, reason: string, lines: string[]): void {
    const wakes = hc().wakes
    // one event per reaction: a retry or a recovery never doubles it
    if (wakes.recent(0).some(w => w.kind === 'reaction' && w.reason.startsWith(tag))) return
    wakes.enqueue({ kind: 'reaction', reason: `${tag} ${reason}`, lines, routine: false })
  }

  /** a like counts for the units its message covered, on the scorecard of their tool and loadout */
  function score(a: MessageActions | undefined, delta: number): void {
    const ctx = getCtx()
    for (const id of uniq([...(a?.units ?? []), ...(a?.merges ?? [])])) {
      const f = findTask(ctx, id)
      if (!f) continue
      const t = f.hc.crew.update(id, { likes: Math.max(0, (f.task.likes ?? 0) + delta) })
      if (t) safe(() => ctx.dispatch.record(t))
    }
  }

  function questHome(id: string): HomeCtx | undefined {
    return [...getCtx().homes.values()].find(h => h.backlog.get(id))
  }

  function openChoice(id: string): Decision | undefined {
    return [...getCtx().homes.values()].flatMap(h => h.decisions.list(true))
      .find(d => !d.resolvedAt && d.action?.kind === 'reaction' && d.action.message === id)
  }

  /** The grace period ran out: pause exactly what the message started, then ask. */
  async function pause(id: string): Promise<void> {
    timers.delete(id)
    const m = messageOf(id)
    if (!m || m.reaction?.kind !== 'dislike' || m.reaction.pause !== 'grace') return
    const ctx = getCtx()
    const at = nowIso()
    const a = m.actions ?? {}
    const units: string[] = [], merges: string[] = [], quests: string[] = [], untouched: string[] = []
    for (const tid of uniq([...(a.units ?? []), ...(a.merges ?? [])])) {
      const f = findTask(ctx, tid)
      if (!f) { untouched.push(`${tid} (gone)`); continue }
      const t = f.task
      if (FINISHED.includes(t.state)) { untouched.push(`${label(t)} (already ${t.state})`); continue }
      if (t.dislikePause) { untouched.push(`${label(t)} (already paused by another dislike)`); continue }
      const running = RUNNING.includes(t.state)
      // interrupt only: the unit, its copy and its session stay, so an undo relaunches it
      if (running && t.terminalId) await f.hc.crew.control(tid, 'interrupt').catch(() => undefined)
      f.hc.crew.update(tid, { dislikePause: { message: id, workspace: home.name, at, prevState: t.state, interrupted: running },
        ...(running ? { state: 'paused' as const, stateReason: 'paused by your dislike' } : {}) })
      ;(running ? units : merges).push(label(t))
    }
    for (const qid of uniq(a.quests ?? [])) {
      const h = questHome(qid)
      const q = h?.backlog.get(qid)
      if (!h || !q) { untouched.push(`quest ${qid} (gone)`); continue }
      if (q.state !== 'queued') { untouched.push(`${quest(q)} (${q.state})`); continue }
      if (q.hold) { untouched.push(`${quest(q)} (already waiting for the player)`); continue }
      const held = h.backlog.hold(qid, DISLIKE_HOLD)
      h.backlog.update(qid, { hold: { ...held.hold!, reaction: id } })
      quests.push(quest(q))
    }
    const any = units.length + quests.length + merges.length > 0
    const summary = pauseSummary(units.length, quests.length, merges.length)
    const excerpt = excerptOf(m)
    const d = openChoice(id) ?? hc().decisions.open({
      key: `reaction:${id}`,
      question: `What's wrong with this message? "${truncate(excerpt, 160)}"`,
      context: [
        any ? `Paused by your dislike: ${[...units, ...quests, ...merges.map(x => `${x} (merge on hold)`)].join('; ')}.` : 'Nothing was running from it, so nothing was paused.',
        ...(untouched.length ? [`Not touched: ${untouched.join('; ')}.`] : []),
        `Message: ${excerptOf(m, 600)}`
      ].join('\n\n'),
      options: any ? [REACTION_OPTIONS.stop, REACTION_OPTIONS.keep, REACTION_OPTIONS.explain] : [REACTION_OPTIONS.explain, REACTION_OPTIONS.keep],
      recommendation: REACTION_OPTIONS.explain,
      urgency: 'urgent',
      source: 'genio',
      project: project(),
      action: { kind: 'reaction', workspace: home.name, message: id }
    })
    save({ ...m, reaction: { ...m.reaction, pause: any ? 'paused' : 'asked', choice: d.id },
      reactionNote: any ? `Paused ${summary}` : 'Nothing was running from it; Genio asked what is wrong' })
    enqueue(`Reaction ${m.reaction.event ?? id} paused:`, `dislike on message ${id}: ${any ? `paused ${summary}` : 'nothing to pause'}; opened choice ${d.id}`, [
      ...units.map(x => `Interrupted and paused ${x}`),
      ...quests.map(x => `Held ${x}`),
      ...merges.map(x => `Merge on hold for ${x}`),
      ...(untouched.length ? [`Not touched: ${untouched.join('; ')}`] : []),
      `Wait for the player's answer to choice ${d.id}: do not relaunch, release, merge or redo this work. Their answer arrives as an answer event.`,
      ACK,
      BOT_RULE
    ])
    bus.publish({ type: 'toast', level: 'warn', title: any ? `Paused ${summary}` : 'Genio will ask what is wrong', body: 'Click the dislike again to undo.' })
    deliver()
  }

  /** Undo a pause: relaunch what was interrupted, restore the rest, release the held quests. */
  async function resume(m: ChatMessage, why: 'undo' | 'answer'): Promise<{ lines: string[]; note: string }> {
    const ctx = getCtx()
    const note = why === 'undo'
      ? 'The player undid their dislike on the Genio message that started this work: the pause was unintended. Continue where you left off.'
      : 'The player answered that this work should keep going. Continue where you left off.'
    const relaunched: string[] = [], restored: string[] = [], released: string[] = [], failed: string[] = []
    for (const h of ctx.homes.values()) {
      for (const t of h.crew.list()) {
        const p = t.dislikePause
        if (p?.message !== m.id || p.workspace !== home.name) continue
        if (p.interrupted && t.state === 'paused') {
          const r = await h.crew.control(t.id, 'relaunch', note, true)
          if (r.ok) { relaunched.push(label(t)); continue }
          h.crew.update(t.id, { dislikePause: undefined, state: p.prevState, stateReason: `resume failed: ${r.message}` })
          failed.push(`${label(t)}: ${r.message}`)
        } else {
          h.crew.update(t.id, { dislikePause: undefined, ...(t.state === 'paused' ? { state: p.prevState, stateReason: 'resumed' } : {}) })
          restored.push(label(t))
        }
      }
      for (const q of h.backlog.list()) {
        if (q.hold?.reaction !== m.id) continue
        h.backlog.release(q.id)
        released.push(quest(q))
      }
    }
    const choice = why === 'undo' ? openChoice(m.id) : undefined
    if (choice) {
      const owner = [...ctx.homes.values()].find(h => h.decisions.get(choice.id))
      safe(() => owner?.decisions.resolve(choice.id, 'Closed: you undid the dislike, so Genio resumed the paused work.', { relay: false }))
    }
    const count = relaunched.length + restored.length
    const resumed = count + released.length > 0 ? `Resumed ${pauseSummary(count, released.length, 0)}` : 'Nothing was paused'
    return {
      note: failed.length ? `${resumed}; ${plural(failed.length, 'unit')} could not relaunch` : resumed,
      lines: [
        ...relaunched.map(x => `Relaunched ${x} with a progress note`),
        ...restored.map(x => `Released ${x}`),
        ...released.map(x => `Released ${x}`),
        ...failed.map(x => `Could not relaunch ${x}`),
        ...(choice ? [`Closed choice ${choice.id} with an explanation`] : []),
        why === 'undo' ? 'Treat the dislike as unintended: tell the player in one short line that the work resumed, then carry on.' : 'Carry on with that work.'
      ]
    }
  }

  async function apply(id: string, kind: ReactionKind | null): Promise<ChatMessage> {
    const m = messageOf(id)
    if (!m || m.role !== 'genio' || m.partial) throw new Error('Only a finished Genio message takes a reaction.')
    const prev = m.reaction?.kind
    // the same reaction again (a double click, a retried call) changes nothing and wakes nobody
    if ((prev ?? null) === kind) return m
    const now = Date.now()
    const at = new Date(now).toISOString()
    const excerpt = excerptOf(m)
    const ev: ReactionEvent = { id: `rx-${rid(6)}`, message: id, workspace: home.name, project: project(), kind: kind ?? 'none',
      ...(prev ? { previous: prev } : {}), at, ...(m.actions ? { actions: m.actions } : {}), excerpt }
    appendJsonl(file, ev)
    const lines = [actionsLine(m.actions)]
    let note = m.reactionNote
    if (prev === 'dislike') {
      clearTimeout(timers.get(id))
      timers.delete(id)
      const pause = m.reaction?.pause
      if (pause === 'grace') {
        const secs = Math.max(0, (now - (Date.parse(m.reaction!.at) || now)) / 1000).toFixed(1)
        lines.push(`The dislike was removed ${secs} s after it was set, inside the ${DISLIKE_GRACE_MS / 1000} s grace period: nothing was paused. The player did not mean it; carry on as before.`)
        note = undefined
      } else if (pause === 'paused' || pause === 'asked') {
        const r = await resume(m, 'undo')
        lines.push(...r.lines)
        note = r.note
      } else {
        lines.push('The paused work had already resumed after the player\'s answer.')
      }
    }
    if (prev === 'like') score(m.actions, -1)
    if (kind === 'like') {
      score(m.actions, 1)
      lines.push(LIKE_RULE)
    } else if (kind === 'dislike') {
      note = undefined
      lines.push(m.actions && Object.values(m.actions).some(v => v?.length)
        ? `After a ${DISLIKE_GRACE_MS / 1000} s grace period Genio pauses exactly those items (units interrupted, queued quests held, merges on hold) and opens one choice asking what is wrong; a follow-up event reports what was paused.`
        : `Nothing to pause: after a ${DISLIKE_GRACE_MS / 1000} s grace period Genio opens one choice asking what is wrong.`,
      'Do not continue that line of work until the player answers that choice.', BOT_RULE)
    } else if (prev === 'like') {
      lines.push('The confirmation is withdrawn; nothing else changes.')
    }
    lines.push(ACK)
    const next: ChatMessage = { ...m, reaction: kind ? { kind, at, event: ev.id, ...(kind === 'dislike' ? { pause: 'grace' as const } : {}) } : undefined, reactionNote: note }
    if (!next.reaction) delete next.reaction
    if (!next.reactionNote) delete next.reactionNote
    save(next)
    const what = !prev ? `${kind}d` : !kind ? `removed their ${prev} on` : `switched ${prev} to ${kind} on`
    enqueue(`Reaction ${ev.id}:`, `Player ${what} your message ${id}: "${excerpt}"`, lines)
    if (kind === 'dislike') {
      // counted now; its side effects wait out the grace period (delivery too, so an undo arrives in the same batch)
      timers.set(id, setTimeout(() => { void serial(() => pause(id)).catch(() => undefined) }, DISLIKE_GRACE_MS))
    } else {
      deliver()
    }
    return next
  }

  return {
    react: (id, kind) => serial(() => apply(id, kind)),

    answered(d, answer) {
      if (d.action?.kind !== 'reaction') return Promise.resolve()
      const id = d.action.message
      return serial(async () => {
        const m = messageOf(id)
        if (!m || m.reaction?.kind !== 'dislike' || !['paused', 'asked'].includes(m.reaction.pause ?? '')) return
        // "stop" or an explanation keeps the work paused; the answer event tells Genio what to do
        if (!keepsGoing(answer)) return
        const r = await resume(m, 'answer')
        save({ ...m, reaction: { ...m.reaction, pause: 'resumed' }, reactionNote: r.note })
      })
    },

    recover() {
      return serial(async () => {
        let count = 0
        for (const m of hc().workspace.history(5000)) {
          if (m.reaction?.kind !== 'dislike' || m.reaction.pause !== 'grace' || timers.has(m.id)) continue
          count++
          const left = DISLIKE_GRACE_MS - (Date.now() - (Date.parse(m.reaction.at) || 0))
          if (left > 0) timers.set(m.id, setTimeout(() => { void serial(() => pause(m.id)).catch(() => undefined) }, left))
          else await pause(m.id)
        }
        return count
      })
    },

    log: () => readJsonl<ReactionEvent>(file),

    stop() {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  }
}

function findTask(ctx: AppCtx, id: string): { hc: HomeCtx; task: Task } | undefined {
  for (const hc of ctx.homes.values()) {
    const task = hc.crew.get(id)
    if (task) return { hc, task }
  }
  return undefined
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}
