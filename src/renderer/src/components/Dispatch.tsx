import { ThumbsDown, ThumbsUp } from 'lucide-react'
import type { Task, Verdict } from '@shared/types'
import { api, op } from '../store'
import { cx } from '../lib/format'

/** States where a unit's work is over (or waiting on the player), so it can be rated. */
export const RATEABLE: Task['state'][] = ['ready', 'merged', 'done', 'failed', 'exited', 'cleaned']

/** 👍/👎 on a unit, saved to the dispatch scorecard right away. */
export function VerdictButtons({ t, label = true }: { t: Task; label?: boolean }) {
  const rate = (v: Verdict): void => {
    if (t.verdict === v) return
    void op('Verdict', () => api().rateTask(t.id, v))
  }
  return (
    <span className="verdict" title="How did this unit do? Feeds the dispatch scorecard.">
      {label && <span className="label">Rate</span>}
      <button className={cx('btn sm ghost icon', t.verdict === 'up' && 'on volt')} aria-label="Good work" onClick={() => rate('up')}>
        <ThumbsUp size={12} />
      </button>
      <button className={cx('btn sm ghost icon', t.verdict === 'down' && 'on alert')} aria-label="Poor work" onClick={() => rate('down')}>
        <ThumbsDown size={12} />
      </button>
    </span>
  )
}

/** Local 👍/👎 choice inside a confirm dialog (sent with the action). */
export function VerdictPick({ value, onChange }: { value?: Verdict; onChange: (v: Verdict | undefined) => void }) {
  return (
    <div className="verdict verdict-pick">
      <span className="mute">How did the unit do?</span>
      <button className={cx('btn sm ghost icon', value === 'up' && 'on volt')} aria-label="Good work" onClick={() => onChange(value === 'up' ? undefined : 'up')}>
        <ThumbsUp size={12} />
      </button>
      <button className={cx('btn sm ghost icon', value === 'down' && 'on alert')} aria-label="Poor work" onClick={() => onChange(value === 'down' ? undefined : 'down')}>
        <ThumbsDown size={12} />
      </button>
    </div>
  )
}

/** Rate (when chosen), then merge: the landing approval carries the verdict. */
export async function rateThenMerge(id: string, verdict?: Verdict): Promise<{ ok: boolean; message: string } | undefined> {
  if (verdict) await api().rateTask(id, verdict).catch(() => undefined)
  return op('Merge', () => api().mergeTask(id))
}

