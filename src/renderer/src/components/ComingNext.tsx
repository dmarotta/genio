import { go, useStore } from '../store'

export function ComingNext() {
  const count = useStore((s) => s.snap.backlog.filter((q) =>
    (q.state === 'queued' || q.state === 'blocked') && !q.hold
  ).length)
  return <button className="link-btn" title="Open Quest Log" onClick={() => go('quests')}>{count} coming next</button>
}
