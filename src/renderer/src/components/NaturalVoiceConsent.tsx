import type { RefObject } from 'react'
import { api } from '../store'
import { Popover } from './Layer'

/**
 * The one consent for the natural voice download (docs/voice.md), at the mic button the first time a reply is read
 * aloud or at Settings → General → Download natural voice. Not now is remembered (the chat offer stays away).
 */
export function NaturalVoiceConsent({ anchor, total, onDownload, onClose }: {
  anchor: RefObject<HTMLElement | null>
  total: number
  onDownload: () => void
  onClose: () => void
}) {
  const decline = (): void => {
    onClose()
    void api().voiceOutputDecline().catch(() => undefined)
  }
  return (
    <Popover anchor={anchor} placement="bottom-end" className="voice-consent panel" onClose={onClose} role="dialog" aria-label="Natural voice">
      <p>Read replies in a natural voice? It runs on this PC and needs a one-time {Math.round(total / 1e6)} MB download.
        Until then, Windows' voice reads them.</p>
      <div className="voice-consent-actions">
        <button type="button" className="btn ghost sm" onClick={decline}>Not now</button>
        <button type="button" className="btn solid sm" onClick={onDownload}>Download</button>
      </div>
    </Popover>
  )
}
