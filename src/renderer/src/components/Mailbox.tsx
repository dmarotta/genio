import { useStore } from '../store'
import { clock, dateShort } from '../lib/format'

/** Notes that reached Genio from scripts and your phone, with Genio's replies. Genio reads and acknowledges them itself. */
export function Mailbox() {
  const notes = useStore((s) => s.snap.inbox)
  if (!notes.length) return null
  const sorted = [...notes].sort((a, b) => b.ts.localeCompare(a.ts))
  return (
    <div className="mail">
      <div className="mail-list">
        {sorted.map((n) => (
          <div key={n.id} className="mail-note">
            <div className="mail-meta">
              <b>{n.from}</b>
              <span className="mono mute">
                {dateShort(n.ts)} {clock(n.ts)}
              </span>
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
