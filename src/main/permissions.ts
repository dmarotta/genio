import type { PermissionRequest } from '@shared/types'
import { bus } from './bus'
import type { AppCtx, PermissionBroker } from './services'
import { nowIso, rid } from './util'

const TIMEOUT_MS = 10 * 60_000

/**
 * Permission broker: when Genio wants to run something outside its read-only
 * allowlist, the player decides through a GUI prompt. Unanswered after ten
 * minutes counts as a refusal.
 */
export function createPermissionBroker(_getCtx: () => AppCtx): PermissionBroker {
  const pending = new Map<string, { req: PermissionRequest; resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>()

  const settle = (id: string, allow: boolean): void => {
    const p = pending.get(id)
    if (!p) return
    clearTimeout(p.timer)
    pending.delete(id)
    bus.publish({ type: 'permission-resolved', id })
    p.resolve(allow)
  }

  return {
    ask(req) {
      const full: PermissionRequest = { ...req, id: `perm-${rid(5)}`, ts: nowIso() }
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => settle(full.id, false), TIMEOUT_MS)
        pending.set(full.id, { req: full, resolve, timer })
        bus.publish({ type: 'permission', request: full })
        bus.publish({ type: 'sfx', sound: 'decision' })
      })
    },
    resolve(id, allow) {
      settle(id, allow)
    },
    pending() {
      return [...pending.values()].map((p) => p.req)
    }
  }
}
