import { PROJECT_WINDOW, api, getState, go, op, playAvailable, subscribe } from '../store'

/**
 * "Play this unit": one-shot requests for the Play screen to preselect a source. Nothing persists: the player's
 * own choice on the Play screen is untouched once the request is used. A request for another window's project is
 * handed over through localStorage (shared by Genio's windows), and that project window is opened or focused.
 */
export interface PlayRequest { world: string; source: string; at: number }

const KEY = 'genio.play.request'
/** A handed-over request older than this is stale (the other window never picked it up). */
const FRESH_MS = 60_000
let pending: PlayRequest | null = null
const listeners = new Set<(request: PlayRequest) => void>()

function readHandover(): PlayRequest | null {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) ?? 'null') as PlayRequest | null
    return r && typeof r.world === 'string' && typeof r.source === 'string' && Date.now() - r.at < FRESH_MS ? r : null
  } catch { return null }
}
function clearHandover(): void {
  try { localStorage.removeItem(KEY) } catch { /* per-viewer convenience only */ }
}

/** Deliver to a mounted Play screen, else keep it and open Play once this window can show it. */
function deliver(request: PlayRequest): void {
  pending = listeners.size ? null : request
  for (const listener of listeners) listener(request)
  if (playAvailable(getState())) { go('play'); return }
  // Before the project list arrives Play is not offered yet: switch as soon as it is.
  const stop = subscribe(() => {
    if (!playAvailable(getState())) return
    stop()
    go('play')
  })
}

/** Open Play with source preselected ('unit:<taskId>', 'main', ...). projectPath opens that project's window if needed. */
export function requestPlaySource(world: string, projectPath: string, source: string): void {
  const request = { world, source, at: Date.now() }
  if (PROJECT_WINDOW === world) { deliver(request); return }
  try { localStorage.setItem(KEY, JSON.stringify(request)) } catch { /* the window still opens, on its last screen */ }
  void op('Open project', () => api().projectOpen(projectPath))
}

/** The request waiting for this project's Play screen, used once. */
export function takePlaySource(world: string): string | undefined {
  const handed = readHandover()
  if (handed?.world === world) { clearHandover(); return handed.source }
  if (pending?.world !== world) return undefined
  const source = pending.source
  pending = null
  return source
}

export function onPlaySourceRequest(listener: (request: PlayRequest) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

// A project window takes requests handed over by the Hub or another window: at start and while it runs.
if (PROJECT_WINDOW && typeof window !== 'undefined') {
  const take = (): void => {
    const r = readHandover()
    if (!r || r.world !== PROJECT_WINDOW) return
    clearHandover()
    deliver(r)
  }
  window.addEventListener('storage', (e) => { if (e.key === KEY && e.newValue) take() })
  take()
}
