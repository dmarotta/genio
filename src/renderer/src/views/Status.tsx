import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { FileText, Flame, Lock, RefreshCw, Trophy } from 'lucide-react'
import type { LedgerRecord, StatusLine, StatusReport } from '@shared/types'
import { api, errText, focusTask, go, setState, useStore } from '../store'
import { Toggle, ViewHeader } from '../components/ui'
import { clock, cx, dateShort, usd } from '../lib/format'
import { toneVar } from '../lib/vocab'

const SECTIONS: { key: keyof Pick<StatusReport, 'yourMove' | 'loot' | 'inProgress' | 'upNext'>; title: string; empty: string; tone: string }[] = [
  { key: 'yourMove', title: 'Your Move', empty: 'Nothing needs your action right now.', tone: 'amber' },
  { key: 'loot', title: 'Loot', empty: 'No recent completions.', tone: 'volt' },
  { key: 'inProgress', title: 'In Progress', empty: 'Nothing is in progress.', tone: 'neon' },
  { key: 'upNext', title: 'Up Next', empty: 'Nothing is queued.', tone: 'violet' }
]

export function Status() {
  const [report, setReport] = useState<StatusReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [includePRs, setIncludePRs] = useState(false)
  const [file, setFile] = useState(false)
  const [ledger, setLedger] = useState<LedgerRecord[]>([])
  const stats = useStore((s) => s.snap.stats)
  const tasksVersion = useStore((s) => s.snap.tasks.length + s.snap.decisions.length + s.snap.backlog.length)

  const generate = useCallback(
    async (opts: { file: boolean; includePRs: boolean }) => {
      setBusy(true)
      setErr('')
      try {
        setReport(await api().statusReport(opts))
      } catch (e) {
        setErr(errText(e))
      } finally {
        setBusy(false)
      }
    },
    []
  )

  useEffect(() => {
    void generate({ file: false, includePRs })
    // refresh when the fleet changes; PR enrichment follows the toggle
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generate, tasksVersion])

  useEffect(() => {
    void api().ledgerTail(60).then((r) => setLedger(r.slice().reverse())).catch(() => setLedger([]))
  }, [tasksVersion])

  const pct = stats.xpNext ? Math.min(100, (stats.xp / stats.xpNext) * 100) : 0
  const unlocked = stats.achievements.filter((a) => a.unlockedAt).length

  return (
    <div className="view">
      <ViewHeader
        kicker={report ? `Generated ${clock(report.generatedAt)}${report.filedPath ? ` · filed` : ''}` : 'Status Screen'}
        title={
          <>
            Status <span className="accent">Screen</span>
          </>
        }
      >
        <Toggle checked={includePRs} onChange={setIncludePRs} label={<span className="label">Include PRs</span>} />
        <Toggle checked={file} onChange={setFile} label={<span className="label">File report</span>} />
        <button className="btn solid" disabled={busy} onClick={() => void generate({ file, includePRs })}>
          <RefreshCw size={14} className={busy ? 'spin' : ''} /> Refresh
        </button>
      </ViewHeader>

      {err && <div className="panel err-panel mono">{err}</div>}
      {report?.filedPath && (
        <button className="filed panel" onClick={() => void api().openPath(report.filedPath!)}>
          <FileText size={14} /> Report filed: <span className="mono">{report.filedPath}</span>
        </button>
      )}

      <div className="status-grid">
        {SECTIONS.map((s) => {
          const lines = report?.[s.key] ?? []
          return (
            <section key={s.key} className={cx('status-sec panel ticks', `sec-${s.tone}`)} style={{ ['--sec' as string]: `var(--${s.tone})` }}>
              <header>
                <h2 className="sec-title">{s.title}</h2>
                <span className="num sec-count">{lines.length}</span>
              </header>
              {!report && busy ? (
                <div className="bar indeterminate">
                  <i />
                </div>
              ) : lines.length === 0 ? (
                <div className="mute sec-empty">{s.empty}</div>
              ) : (
                <ul className="sec-lines">
                  {lines.map((l, i) => (
                    <Line key={i} l={l} />
                  ))}
                </ul>
              )}
            </section>
          )
        })}
      </div>

      <div className="stats-row">
        <section className="panel stats-card ticks">
          <div className="level-big">
            <div className="lv-hex">
              <svg viewBox="0 0 100 100" width="92" height="92">
                <polygon points="50,3 93,27 93,73 50,97 7,73 7,27" fill="rgba(198,255,61,0.06)" stroke="var(--volt)" strokeWidth="2" />
              </svg>
              <div className="lv-num num">{stats.level}</div>
            </div>
            <div className="lv-meta">
              <div className="label">Level</div>
              <div className="bar" style={{ ['--c' as string]: 'var(--volt)', width: 220, marginTop: 8 }}>
                <i style={{ width: `${pct}%` }} />
              </div>
              <div className="mute mono" style={{ marginTop: 6, fontSize: 12 }}>
                {stats.xp} / {stats.xpNext} XP
              </div>
            </div>
          </div>
          <div className="stat-tiles">
            <Tile label="Shipped today" value={stats.shippedToday} tone="volt" />
            <Tile label="Shipped total" value={stats.shippedTotal} tone="neon" />
            <Tile label="Recons" value={stats.scoutsTotal} tone="violet" />
            <Tile label="Streak" value={`${stats.streakDays}d`} tone="amber" icon={<Flame size={14} />} />
            <Tile label="Chat/review estimate today" value={usd(stats.costTodayUsd)} tone="mute" />
          </div>
        </section>
        <section className="panel achv-grid-card">
          <header className="card-head">
            <span className="label">Achievements</span>
            <span className="num dim">
              {unlocked}/{stats.achievements.length}
            </span>
          </header>
          <div className="achv-grid">
            {stats.achievements.map((a) => (
              <div key={a.id} className={cx('achv-tile', a.unlockedAt ? 'got' : 'locked')} title={a.description}>
                <div className="achv-ico">{a.unlockedAt ? <Trophy size={18} /> : <Lock size={16} />}</div>
                <div className="achv-tname">{a.name}</div>
                <div className="achv-tdesc">{a.unlockedAt ? dateShort(a.unlockedAt) : a.description}</div>
              </div>
            ))}
            {!stats.achievements.length && <div className="mute">No achievements defined.</div>}
          </div>
        </section>
      </div>

      <section className="panel replay">
        <header className="card-head">
          <span className="label">Replay log</span>
          <span className="mute" style={{ fontSize: 12 }}>
            {ledger.length ? 'Newest first' : 'Enable the Replay log in Systems to record squad activity'}
          </span>
        </header>
        <div className="replay-list mono">
          {ledger.map((r, i) => (
            <div key={i} className="replay-row">
              <span className="mute">{dateShort(r.ts)} {clock(r.ts)}</span>
              <span className="replay-ev">{r.event}</span>
              <span className="dim">{r.task ?? r.project ?? ''}</span>
              <span className="mute replay-data">{r.data ? JSON.stringify(r.data).slice(0, 140) : ''}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function Line({ l }: { l: StatusLine }) {
  const click = (): void => {
    if (l.taskId) focusTask(l.taskId)
    else if (l.decisionId) go('move')
    else if (l.backlogId) setState({ view: 'quests' })
    else if (l.url) void api().openExternal(l.url)
  }
  const clickable = !!(l.taskId || l.decisionId || l.backlogId || l.url)
  return (
    <li className={cx('sec-line', clickable && 'click')} onClick={clickable ? click : undefined}>
      <i className="sec-dot" style={{ background: l.tone ? toneVar(l.tone) : 'var(--sec)' }} />
      <span className="selectable">{l.text}</span>
      {l.url && (
        <a
          className="sec-url mono"
          onClick={(e) => {
            e.stopPropagation()
            void api().openExternal(l.url!)
          }}
        >
          {l.url.replace(/^https?:\/\/(www\.)?/, '')}
        </a>
      )}
    </li>
  )
}

function Tile({ label, value, tone, icon }: { label: string; value: string | number; tone: string; icon?: ReactNode }) {
  return (
    <div className="tile">
      <div className="tile-val num" style={{ color: tone === 'mute' ? 'var(--text)' : `var(--${tone})` }}>
        {icon} {value}
      </div>
      <div className="label">{label}</div>
    </div>
  )
}
