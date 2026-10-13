/**
 * Notifier: desktop notifications, outbound webhooks (Discord / Slack /
 * generic JSON) and sound effects. Every channel is best-effort and never
 * throws into the caller.
 */
import path from 'node:path'
import type { NotifyTarget, SfxName } from '@shared/types'
import { bus } from './bus'
import type { AppCtx, NotifierService, NotifyOptions } from './services'

type Severity = 'info' | 'decision' | 'failure' | 'ready'

const SEVERITY_ICON: Record<Severity, string> = {
  info: '[i]',
  decision: '[YOUR MOVE]',
  failure: '[FAIL]',
  ready: '[LOOT]'
}

// Shown notifications stay referenced until closed: on Windows a collected
// Notification drops its click handler.
const live = new Set<unknown>()

async function desktopNotify(appRoot: string, title: string, body: string, severity: Severity, target?: NotifyTarget): Promise<void> {
  try {
    // Imported lazily so this module also loads outside Electron (tests).
    const electron = await import('electron')
    const N = electron.Notification
    if (!N || typeof N.isSupported !== 'function' || !N.isSupported()) return
    const icon = electron.nativeImage.createFromPath(path.join(appRoot, 'resources', 'icon.png'))
    const n = new N({
      title,
      body,
      silent: true,
      icon: icon.isEmpty() ? undefined : icon,
      urgency: severity === 'failure' || severity === 'decision' ? 'critical' : 'normal'
    })
    const drop = (): void => void live.delete(n)
    n.on('click', () => {
      drop()
      const win = electron.BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      if (win) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
      if (target) bus.publish({ type: 'navigate', target })
    })
    n.on('close', drop)
    n.on('failed', drop)
    live.add(n)
    n.show()
  } catch {
    /* not running inside Electron, or notifications unavailable */
  }
}

async function postWebhook(url: string, kind: 'discord' | 'slack' | 'generic', title: string, body: string, severity: Severity): Promise<void> {
  if (!url) return
  const tag = SEVERITY_ICON[severity]
  const text = `${tag} ${title}${body ? `\n${body}` : ''}`
  const payload =
    kind === 'discord'
      ? { content: text.slice(0, 1900), username: 'Genio' }
      : kind === 'slack'
        ? { text }
        : { title, body, severity, source: 'genio' }
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 10_000)
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctl.signal
    })
    clearTimeout(timer)
  } catch {
    /* webhook failures are non-fatal */
  }
}

export function createNotifierService(getCtx: () => AppCtx): NotifierService {
  return {
    notify(title, body, severity, opts: NotifyOptions = {}) {
      let s, appRoot
      try {
        const ctx = getCtx()
        s = ctx.settings.get()
        appRoot = ctx.appRoot
      } catch {
        return
      }
      if (s.desktopNotifications || opts.force) void desktopNotify(appRoot, title, body, severity, opts.target)
      if (s.webhookUrl) void postWebhook(s.webhookUrl, s.webhookKind, title, body, severity)
    },
    sfx(name: SfxName) {
      try {
        if (!getCtx().settings.get().sound) return
      } catch {
        return
      }
      bus.publish({ type: 'sfx', sound: name })
    }
  }
}
