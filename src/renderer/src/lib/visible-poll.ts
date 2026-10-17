/**
 * A fallback poll that only matters while the window is seen: `run` every `ms` while the document is visible;
 * a run that came due while it was hidden (minimized) happens once it is visible again. Returns the stop.
 */
export function pollWhileVisible(run: () => void, ms: number, doc: Document = document): () => void {
  let missed = false
  const timer = window.setInterval(() => { if (doc.hidden) missed = true; else run() }, ms)
  const back = (): void => { if (!doc.hidden && missed) { missed = false; run() } }
  doc.addEventListener('visibilitychange', back)
  return () => { window.clearInterval(timer); doc.removeEventListener('visibilitychange', back) }
}
