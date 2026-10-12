/** Fan-out of batched terminal output from main to per-terminal listeners. */
type Listener = (data: string) => void

const listeners = new Map<string, Set<Listener>>()
let wired = false

function wire(): void {
  if (wired || !window.genio?.onTerminalData) return
  wired = true
  window.genio.onTerminalData((batch) => {
    for (const chunk of batch) {
      const set = listeners.get(chunk.id)
      if (set) for (const l of set) l(chunk.data)
    }
  })
}

export function onTerminal(id: string, fn: Listener): () => void {
  wire()
  let set = listeners.get(id)
  if (!set) {
    set = new Set()
    listeners.set(id, set)
  }
  set.add(fn)
  return () => {
    set!.delete(fn)
    if (!set!.size) listeners.delete(id)
  }
}
