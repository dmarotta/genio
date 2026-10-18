/**
 * Compat readers for data written before the "wksp" concept was renamed to "workspace": every persisted record
 * (events, tasks, decisions, plans, chat sessions, settings) keeps loading, and only the new key is ever written.
 * The one place the old key is still spelled out.
 */

const OLD_KEY = /^wksp(?=[A-Z]|$)/

/** JSON.parse reviver: an object with an old `wksp…` key is returned with it renamed `workspace…` (an existing new key wins). */
export function upgradeKeys(_key: string, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const rec = value as Record<string, unknown>
  if (!Object.keys(rec).some(k => OLD_KEY.test(k))) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rec)) {
    const nk = k.replace(OLD_KEY, 'workspace')
    if (nk !== k && nk in rec) continue
    out[nk] = v
  }
  return out
}
