/** Interactive loads preempt the hidden thumbnail renderer, including an already running parse. */
export class ModelPreviewPriority {
  private readonly loads = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly listeners = new Set<() => void>()
  get active(): boolean { return this.loads.size > 0 }
  begin(id: string, timeoutMs = 35_000): void {
    this.finish(id)
    const timer = setTimeout(() => this.finish(id), timeoutMs)
    timer.unref()
    this.loads.set(id, timer)
    this.changed()
  }
  finish(id: string): void {
    const timer = this.loads.get(id)
    if (!timer) return
    clearTimeout(timer); this.loads.delete(id); this.changed()
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  async idle(signal: AbortSignal): Promise<void> {
    if (!this.active || signal.aborted) return
    await new Promise<void>(resolve => {
      const done = (): void => { off(); signal.removeEventListener('abort', done); resolve() }
      const off = this.subscribe(() => { if (!this.active) done() })
      signal.addEventListener('abort', done, { once: true })
    })
  }
  private changed(): void { for (const listener of this.listeners) listener() }
}
export const modelPreviewPriority = new ModelPreviewPriority()
