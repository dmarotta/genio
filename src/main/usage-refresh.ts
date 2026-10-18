/** Account probes share these limits across timers, previews and launch preflights. */
export const USAGE_PROBE_INTERVAL = 60_000
export const USAGE_REFRESH_INTERVAL = 2 * 60_000
export const usageRetryDelay = (failures: number): number => Math.min(30 * 60_000, USAGE_REFRESH_INTERVAL * 2 ** Math.max(0, failures - 1))

/** Main-process lifecycle, independent of renderer subscriptions. Never overlaps refreshes. */
export function usageRefreshLoop(refresh: () => Promise<boolean>, active: () => boolean): { start(): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  let started = false
  let failures = 0
  const run = async (epoch: number, startup = false): Promise<void> => {
    try {
      if (startup || active()) failures = await refresh() ? 0 : failures + 1
      else failures = 0
    } catch { failures++ }
    if (!started || epoch !== generation) return
    timer = setTimeout(() => void run(epoch), failures ? usageRetryDelay(failures) : USAGE_REFRESH_INTERVAL)
    timer.unref?.()
  }
  return {
    start() { if (!started) { started = true; void run(++generation, true) } },
    stop() { started = false; generation++; clearTimeout(timer); timer = undefined }
  }
}
