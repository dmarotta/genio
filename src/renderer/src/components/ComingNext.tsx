import { questCounts } from '@shared/quest-summary'
import { go, useStore } from '../store'

export function ComingNext() {
  const count = useStore((s) => questCounts(s.snap.backlog).comingNext)
  return <button className="link-btn" title="Open Quest Log" onClick={() => go('quests')}>{count} coming next</button>
}
