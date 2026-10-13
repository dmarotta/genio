import { useState } from 'react'
import { Send } from 'lucide-react'
import { api, op, useStore } from '../store'
import { clock, cx, dateShort } from '../lib/format'

/** Notes for Genio: compose, read its replies, acknowledge. */
export function Mailbox() {
  const notes = useStore((s) => s.snap.inbox)
  const gamertag = useStore((s) => s.settings?.gamertag)
  const [text, setText] = useState('')
  const sorted = [...notes].sort((a, b) => b.ts.localeCompare(a.ts))
  return (
    <div className="mail">
      <div className="mail-compose">
        <textarea className="textarea" rows={3} value={text} aria-label="Note for Genio" placeholder="Leave Genio a note — it picks it up on the next event." onChange={(e) => setText(e.target.value)} />
        <button
          className="btn sm solid"
          disabled={!text.trim()}
          onClick={async () => {
            const r = await op('Mail sent', () => api().inboxSubmit(text.trim(), gamertag || 'Player'), () => 'Genio will read it next')
            if (r) setText('')
          }}
        >
          <Send size={12} /> Send
        </button>
      </div>
      <div className="mail-list">
        {sorted.length === 0 && <div className="mute side-empty">No mail.</div>}
        {sorted.map((n) => (
          <div key={n.id} className={cx('mail-note', !n.ackedAt && 'unread')}>
            <div className="mail-meta">
              <b>{n.from}</b>
              <span className="mono mute">
                {dateShort(n.ts)} {clock(n.ts)}
              </span>
              {!n.ackedAt ? (
                <button className="btn sm ghost" onClick={() => void op('Mail', () => api().inboxAck(n.id))}>
                  Ack
                </button>
              ) : (
                <span className="chip volt">read</span>
              )}
            </div>
            <div className="mail-text selectable">{n.text}</div>
            {n.reply && (
              <div className="mail-reply selectable">
                <span className="label neon-text">Genio</span> {n.reply}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
