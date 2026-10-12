/**
 * Notifier: desktop notifications, outbound webhooks (Discord / Slack /
 * generic JSON) and sound effects. Every channel is best-effort and never
 * throws into the caller.
 */
import type { SfxName } from '@shared/types'
import { bus } from './bus'
import type { AppCtx, NotifierService } from './services'

type Severity = 'info' | 'decision' | 'failure' | 'ready'

const SEVERITY_ICON: Record<Severity, string> = {
  info: '[i]',
  decision: '[YOUR MOVE]',
  failure: '[FAIL]',
  ready: '[LOOT]'
}

async function desktopNotify(title: string, body: string): Promise<void> {
  try {
    // Imported lazily so this module also loads outside Electron (tests).
    const electron = await import('electron')
    const N = electron.Notification
    if (!N || typeof N.isSupported !== 'function' || !N.isSupported()) return
    new N({ title, body, silent: true }).show()
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
    notify(title, body, severity) {
      let s
      try {
        s = getCtx().settings.get()
      } catch {
        return
      }
      if (s.desktopNotifications) void desktopNotify(title, body)
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
