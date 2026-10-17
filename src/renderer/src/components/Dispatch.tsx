import { ThumbsDown, ThumbsUp } from 'lucide-react'
import type { Task, Verdict } from '@shared/types'
import { api, op } from '../store'
import { cx } from '../lib/format'

/** 👍/👎 on a finished unit, saved to the dispatch scorecard right away. */
export function VerdictButtons({ t }: { t: Task }) {
  const rate = (v: Verdict): void => {
    if (t.verdict === v) return
    void op('Verdict', () => api().rateTask(t.id, v))
  }
  return (
    <span className="verdict">
      <button className={cx('btn sm ghost icon', t.verdict === 'up' && 'on volt')} aria-label="Good work" onClick={() => rate('up')}>
        <ThumbsUp size={12} />
      </button>
      <button className={cx('btn sm ghost icon', t.verdict === 'down' && 'on alert')} aria-label="Poor work" onClick={() => rate('down')}>
        <ThumbsDown size={12} />
      </button>
    </span>
  )
}
