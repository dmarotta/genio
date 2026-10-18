/**
 * Standing merge approvals: "keep merging everything" said by the player in a
 * project's chat lets Genio merge that project's Builds as they become ready
 * (green and in scope, the same guards as any merge) without asking each time.
 * Never destructive actions. Held in memory only, so a restart ends it; it also
 * expires after STANDING_HOURS, and the player revokes it with one click or by
 * saying stop.
 */
import type { ChatMessage, StandingApproval } from '@shared/types'
import type { AppCtx } from './services'
import type { Home } from './home'
import { bus } from './bus'
import { rid } from './util'
import { isStandingApproval, isStandingRevoke, normalizeWords } from './player-words'

export const STANDING_HOURS = 8

export class StandingApprovals {
  private rows: StandingApproval[] = []
  constructor(private ctx: AppCtx) {}

  /** Active approvals, every project. */
  list(now = Date.now()): StandingApproval[] {
    return this.rows.filter(a => Date.parse(a.expiresAt) > now)
  }

  active(project: string, now = Date.now()): StandingApproval | undefined {
    return this.list(now).find(a => a.project === project)
  }

  /** One per project: a newer approval replaces the old one. */
  record(a: Pick<StandingApproval, 'project' | 'workspace' | 'messageId' | 'text'>, now = Date.now()): StandingApproval {
    const row: StandingApproval = { ...a, id: `sa-${rid(6)}`, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + STANDING_HOURS * 3_600_000).toISOString() }
    this.rows = [...this.rows.filter(x => x.project !== a.project && Date.parse(x.expiresAt) > now), row]
    this.changed('approval.standing', row)
    return row
  }

  revoke(id: string, by: 'player' | 'words' = 'player'): StandingApproval | undefined {
    const row = this.rows.find(a => a.id === id)
    if (!row) return undefined
    this.rows = this.rows.filter(a => a !== row)
    this.changed('approval.revoked', row, by)
    return row
  }

  private changed(event: 'approval.standing' | 'approval.revoked', row: StandingApproval, by?: string): void {
    try {
      this.ctx.ledger.record({ home: row.workspace, event, project: row.project, data: { id: row.id, messageId: row.messageId, text: row.text, expiresAt: row.expiresAt, ...(by ? { by } : {}) } })
    } catch { /* the ledger is optional */ }
    bus.publish({ type: 'standing-approvals', approvals: this.list() })
  }
}

const stores = new WeakMap<AppCtx, StandingApprovals>()
export function standingApprovals(ctx: AppCtx): StandingApprovals {
  let s = stores.get(ctx)
  if (!s) { s = new StandingApprovals(ctx); stores.set(ctx, s) }
  return s
}

/** The projects a chat speaks for: an Ally's own; in the main chat, the ones named (or the only one). */
function chatProjects(ctx: AppCtx, home: Home, text: string): string[] {
  if (!home.isMain) return ctx.allies.list().find(a => a.name === home.name && !a.retiredAt)?.projects ?? []
  const all = ctx.projects.list().map(p => p.name)
  const n = normalizeWords(text)
  const named = all.filter(p => n.includes(p.toLowerCase()))
  return named.length ? named : all.length === 1 ? all : []
}

const until = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * A player message the session just read: record or revoke a standing approval.
 * Returns the receipt line for the chat, if anything changed.
 */
export function noteStandingWords(ctx: AppCtx, home: Home, m: ChatMessage): string | undefined {
  if (m.role !== 'player' || !m.text?.trim() || m.text.trim().startsWith('/')) return undefined
  const store = standingApprovals(ctx)
  if (isStandingRevoke(m.text)) {
    const projects = chatProjects(ctx, home, m.text)
    const gone = store.list().filter(a => a.workspace === home.name && (projects.includes(a.project) || !projects.length))
    for (const a of gone) store.revoke(a.id, 'words')
    return gone.length ? `Standing merge approval revoked for ${gone.map(a => a.project).join(', ')}. Merges wait for your word again.` : undefined
  }
  if (!isStandingApproval(m.text)) return undefined
  const projects = chatProjects(ctx, home, m.text)
  if (!projects.length) return undefined
  const rows = projects.map(project => store.record({ project, workspace: home.name, messageId: m.id, text: m.text.trim() }))
  return `Standing merge approval recorded for ${projects.join(', ')} until ${until(rows[0].expiresAt)} (or until Genio restarts): Genio may merge Builds there as they become ready and pass their checks. It never covers destructive actions. Revoke it from the title bar, or say "stop merging".`
}
